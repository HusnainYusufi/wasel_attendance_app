import { ReminderKind, reminderScheduleSchema, type ReminderScheduleDto } from '@wasel/contracts';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClockService } from '../../src/common/clock/clock.service.js';
import { AttendanceModule } from '../../src/modules/attendance/attendance.module.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { RemindersModule } from '../../src/modules/reminders/reminders.module.js';
import { HQ, createSite, punchAt } from '../support/attendance.js';
import {
  FixedClockService,
  createTestApp,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

const SCHEDULE = '/reminders/schedule';
const CHECK_IN = '/attendance/check-in';
const CHECK_OUT = '/attendance/check-out';
const RIYADH = 'Asia/Riyadh';

/** 09:12 local in Riyadh — twelve minutes into a 09:00–18:00 day. */
const MORNING = new Date('2026-03-10T06:12:00.000Z');

const localTime = (iso: string, zone = RIYADH): string =>
  DateTime.fromISO(iso, { zone }).toFormat('HH:mm');

describe('reminders schedule', () => {
  let ctx: TestApp;
  const clock = new FixedClockService(MORNING);

  beforeAll(async () => {
    ctx = await createTestApp({
      // `RemindersModule` is mounted explicitly rather than relied upon through
      // `AppModule`: the application root is wired by the orchestrator, and this
      // suite must exercise the module whether or not that has happened yet.
      // Nest instantiates a module once however many times it is imported, so
      // this stays correct after the root picks it up too.
      imports: [AuthModule, AttendanceModule, RemindersModule],
      env: { RATE_LIMIT_MAX: '100000', JWT_ACCESS_TTL: '30d' },
      configure: (builder) => builder.overrideProvider(ClockService).useValue(clock),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    clock.set(MORNING);
  });

  async function riyadhActor(): Promise<AuthenticatedActor> {
    const actor = await createUserAndLogin(ctx, { organization: { timezone: RIYADH } });
    await createSite(ctx, actor.organization.id);
    return actor;
  }

  const schedule = async (actor: AuthenticatedActor): Promise<ReminderScheduleDto> => {
    const response = await actor.get(SCHEDULE).expect(200);
    return reminderScheduleSchema.parse(response.body);
  };

  it('is empty before the user has checked in', async () => {
    const actor = await riyadhActor();

    await expect(schedule(actor)).resolves.toMatchObject({ reminders: [] });
  });

  it('requires authentication', async () => {
    await ctx.http.get(`/api/v1${SCHEDULE}`).expect(401);
  });

  it('plans two reminders at sensible local times after a check-in', async () => {
    const actor = await riyadhActor();
    await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

    const body = await schedule(actor);

    expect(body.reminders.map((reminder) => reminder.kind)).toEqual([
      ReminderKind.STILL_THERE,
      ReminderKind.CHECKOUT_SOON,
    ]);
    for (const reminder of body.reminders) {
      const at = Date.parse(reminder.at);
      expect(at).toBeGreaterThan(MORNING.getTime());
      // 18:00 in Riyadh is 15:00Z; nothing may be planned past the day's end.
      expect(at).toBeLessThan(Date.parse('2026-03-10T15:00:00.000Z'));
    }
    // The "check out soon" nudge is in the last stretch of the afternoon.
    expect(localTime(body.reminders[1]?.at ?? '') >= '17:00').toBe(true);
  });

  it('returns the same instants when the client re-fetches', async () => {
    const actor = await riyadhActor();
    await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

    const first = await schedule(actor);
    // A reload, a resume, a token refresh — the client asks again, minutes later.
    clock.advanceMs(11 * 60_000);
    const second = await schedule(actor);

    expect(second.reminders).toEqual(first.reminders);
  });

  it('empties on check-out', async () => {
    const actor = await riyadhActor();
    await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
    expect((await schedule(actor)).reminders.length).toBeGreaterThanOrEqual(2);

    clock.advanceMs(4 * 60 * 60_000);
    await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

    await expect(schedule(actor)).resolves.toMatchObject({ reminders: [] });
  });

  it('drops a reminder once its instant has passed, without moving the others', async () => {
    const actor = await riyadhActor();
    await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
    const planned = (await schedule(actor)).reminders;

    // Move past the first reminder but not the second.
    clock.set(new Date(Date.parse(planned[0]?.at ?? '') + 60_000));
    const later = await schedule(actor);

    expect(later.reminders).toEqual([planned[1]]);
  });

  it('gives two different employees different times for the same shift', async () => {
    const first = await riyadhActor();
    const second = await createUserAndLogin(ctx, { organizationId: first.organization.id });
    await first.post(CHECK_IN).send(punchAt(HQ)).expect(201);
    await second.post(CHECK_IN).send(punchAt(HQ)).expect(201);

    const a = await schedule(first);
    const b = await schedule(second);

    expect(a.reminders.map((r) => r.at)).not.toEqual(b.reminders.map((r) => r.at));
  });

  it('cannot see another tenant’s shift', async () => {
    const mine = await riyadhActor();
    const theirs = await riyadhActor();
    await theirs.post(CHECK_IN).send(punchAt(HQ)).expect(201);

    await expect(schedule(mine)).resolves.toMatchObject({ reminders: [] });
  });

  it('sends a single reminder when the check-in leaves only a short window', async () => {
    const actor = await riyadhActor();
    // 17:50 local: ten minutes before an 18:00 workday end.
    clock.set(new Date('2026-03-10T14:50:00.000Z'));
    await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

    const body = await schedule(actor);

    expect(body.reminders.map((reminder) => reminder.kind)).toEqual([ReminderKind.CHECKOUT_SOON]);
  });

  it('plans a nominal shift from arrival for a check-in after the workday end', async () => {
    const actor = await riyadhActor();
    // 19:30 local: the organization's 18:00 end is already behind us.
    clock.set(new Date('2026-03-10T16:30:00.000Z'));
    await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

    const body = await schedule(actor);

    expect(body.reminders).toHaveLength(2);
    // Nine hours from arrival lands at 04:30 local the next morning.
    expect(localTime(body.reminders[1]?.at ?? '')).toMatch(/^0[34]:/);
  });
});
