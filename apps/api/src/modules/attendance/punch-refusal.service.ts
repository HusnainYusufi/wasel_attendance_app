import { Injectable } from '@nestjs/common';
import {
  PunchOutcome,
  PunchType,
  findNearestSite,
  punchRequestSchema,
  type PunchRequest,
} from '@wasel/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { clientInfoFromRequest } from '../auth/client-context.js';
import { bearerToken } from '../auth/guards/jwt-auth.guard.js';
import { TokenService } from '../auth/token.service.js';
import { AttendanceEventService } from './attendance-event.service.js';
import { toGeofenceSite, GEOFENCE_SITE_SELECT } from './attendance.mapper.js';
import { businessDateIn, parseInstant } from './work-date.js';

/** Which punch a request was, by the route it reached. */
const PUNCH_ROUTES: ReadonlyArray<readonly [suffix: string, type: PunchType]> = [
  ['/attendance/check-in', PunchType.CHECK_IN],
  ['/attendance/check-out', PunchType.CHECK_OUT],
];

/**
 * The audit row for a punch that never reached the attendance rules.
 *
 * CONVENTIONS §2.5 says every punch attempt is persisted, "including rejections
 * … a rejected punch is the single most interesting row for an auditor". The
 * service honours that for every rejection it decides itself, but a refusal
 * raised *above* it — by the globally registered authentication guard — left no
 * row at all, and that gap covered exactly the case the log exists for: a
 * suspended employee still standing at the office tapping check-in.
 *
 * Only refusals of an authenticated principal are filed, because only those
 * carry the `userId` and `organizationId` the columns require. Two gaps are
 * deliberate, and are gaps rather than oversights:
 *
 *  * **`400 VALIDATION_FAILED`.** The coordinate columns are `NOT NULL` and a
 *    payload the schema refused has no trustworthy coordinates to put in them.
 *    Filing zeroes would be inventing a location, which is worse than filing
 *    nothing; the request log records that the attempt happened.
 *  * **`429 RATE_LIMITED`.** Persisting a row per throttled request turns the
 *    rate limiter — whose entire job is to shed load — into a write amplifier,
 *    and hands anyone with one valid token an unbounded insert channel into the
 *    audit table. Throttled attempts are *beyond* the limit by definition, so
 *    unlike a suspended user's punches they are not bounded by anything. They
 *    are recorded by the request logger, with the `code` and the route, which is
 *    the right place for evidence that costs nothing to produce.
 */
@Injectable()
export class PunchRefusalAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AttendanceEventService,
    private readonly tokens: TokenService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Files `outcome` against the punch `request` was carrying, if it can be read.
   *
   * Never throws: it runs while a 4xx is already on its way to the client, and
   * the client must see that answer whatever happens here.
   */
  async record(request: Request, outcome: PunchOutcome): Promise<void> {
    const type = punchTypeFor(request);
    if (type === null) return;

    const punch = punchRequestSchema.safeParse(request.body);
    if (!punch.success) return;

    try {
      const auth = await this.principalFor(request);
      if (auth === null) return;
      await this.file(auth, type, outcome, punch.data, request);
    } catch {
      // A refusal that cannot be audited must not become a different refusal.
      // `AttendanceEventService.record` already logs its own failures; anything
      // reaching here is a token or policy read, and the request log has the rest.
    }
  }

  private async file(
    auth: AuthContext,
    type: PunchType,
    outcome: PunchOutcome,
    punch: PunchRequest,
    request: Request,
  ): Promise<void> {
    const [organization, sites] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: auth.organizationId },
        select: { timezone: true, dayStartsAt: true },
      }),
      this.prisma.site.findMany({
        where: { organizationId: auth.organizationId, isActive: true, deletedAt: null },
        select: GEOFENCE_SITE_SELECT,
      }),
    ]);
    if (organization === null) return;

    await this.events.record({
      auth,
      type,
      outcome,
      workDate: businessDateIn(this.clock.now(), organization.timezone, organization.dayStartsAt),
      latitude: punch.latitude,
      longitude: punch.longitude,
      accuracyM: punch.accuracy,
      // Where the refused attempt was made matters as much as that it happened:
      // "suspended, and standing in the office" and "suspended, and forty
      // kilometres away" are different stories about the same outcome code.
      nearest: findNearestSite(punch, sites.map(toGeofenceSite)),
      deviceTime: parseInstant(punch.deviceTime),
      client: clientInfoFromRequest(request),
    });
  }

  /**
   * The principal, re-derived from the bearer token.
   *
   * The guard refuses a suspended account *before* publishing the auth context,
   * so there is nothing on the request to read. Re-verifying the signature is
   * what makes this safe: the identity filed comes from a token the application
   * has cryptographically accepted, not from a header. It is one extra verify on
   * a path that is already returning an error, and no extra database read.
   */
  private async principalFor(request: Request): Promise<AuthContext | null> {
    const raw = bearerToken(request.headers?.authorization);
    if (raw === null) return null;

    const claims = await this.tokens.verifyAccessToken(raw);
    return {
      userId: claims.sub,
      organizationId: claims.org,
      role: claims.role,
      tokenVersion: claims.tv,
    };
  }
}

function punchTypeFor(request: Request): PunchType | null {
  if (request.method !== 'POST') return null;
  const path = request.path;
  return PUNCH_ROUTES.find(([suffix]) => path.endsWith(suffix))?.[1] ?? null;
}
