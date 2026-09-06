import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type Server } from 'node:http';
import { AttendanceStatus, Role } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminModule } from '../../src/modules/admin/admin.module.js';
import type {
  DeadlineResponse,
  ResponseDeadline,
  ResponseDeadlineOptions,
} from '../../src/modules/admin/export/response-deadline.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { seedSite } from '../fixtures/admin-fixtures.js';
import {
  createUserAndLogin,
  createTestApp,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

/**
 * The export's response deadline, against a real socket.
 *
 * Only the *budget* is shortened here, and only so the suite finishes in seconds
 * rather than minutes; the shipped numbers are asserted in
 * `src/modules/admin/__tests__/response-deadline.spec.ts`. Everything else is
 * real: a real listening server, a real client opening a real export, real kernel
 * socket buffers filling up, and the export's own abort path recording what
 * happened.
 *
 * Both halves matter equally. A deadline that closes a stalled connection is
 * worth having; a deadline that also closes a genuinely slow download is worse
 * than the leak it was meant to fix, because it turns a rare resource problem
 * into a routine failure to deliver payroll data over a bad connection.
 */
const STALL_BUDGET_MS = 6_000;
const STALL_POLL_MS = 300;

/**
 * The real module's shape, spelled out rather than derived.
 *
 * A `typeof import(...)` annotation would be the obvious way to write this, and
 * the lint rule that forbids it is right: it hides a module dependency from every
 * tool that reads the import list. Naming the three exports the mock has to
 * preserve is also a check in itself — adding a fourth and forgetting it here
 * fails to compile.
 */
interface DeadlineModule {
  installResponseDeadline: (
    response: DeadlineResponse,
    options?: ResponseDeadlineOptions,
  ) => ResponseDeadline;
  EXPORT_STALL_TIMEOUT_MS: number;
  EXPORT_STALL_POLL_MS: number;
}

vi.mock('../../src/modules/admin/export/response-deadline.js', async (importOriginal) => {
  const actual = await importOriginal<DeadlineModule>();
  return {
    ...actual,
    installResponseDeadline: (
      response: DeadlineResponse,
      options: ResponseDeadlineOptions = {},
    ): ResponseDeadline =>
      actual.installResponseDeadline(response, {
        ...options,
        timeoutMs: STALL_BUDGET_MS,
        pollMs: STALL_POLL_MS,
      }),
  };
});

/**
 * Big enough that neither half of the file can be swallowed by a socket buffer.
 *
 * Two constraints, both measured. A download small enough to fit in the kernel
 * buffers completes without the client ever reading a byte, which proves nothing
 * about a stall — a loopback connection absorbed 850 kB before the export first
 * blocked. And the slow half has to outlive the budget while reading fast enough
 * that the sender's *silence between bursts* (`burst ÷ read rate`, ~600 kB ÷ 320
 * kB/s ≈ 2 s here) stays well inside it.
 *
 * What matters is therefore **bytes, not rows**, so the fixture buys them with
 * wide columns rather than with a large table: 8,000 rows of ~500 B is the same
 * 4 MB as 30,000 narrow ones and costs this shared database a quarter of the
 * inserts on every run of the suite.
 */
const CROWD = 100;
const DAYS = 80;
const RANGE = 'from=2026-03-01&to=2026-05-19';

/** Long, but every column is within its own `VarChar` limit. */
const LONG_NAME_PAD = 'Ibn Abdulaziz Al Mutairi Al Otaibi Al Dossari Al Qahtani';
const LONG_SITE_NAME =
  'Head Office — North Tower, Floors 11 to 19, King Fahd Road, Al Olaya District, Riyadh';

function workDay(index: number): string {
  return new Date(Date.UTC(2026, 2, 1 + index)).toISOString().slice(0, 10);
}

describe('the export response deadline', () => {
  let ctx: TestApp;
  let admin: AuthenticatedActor;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AdminModule],
      env: { RATE_LIMIT_MAX: '100000' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    admin = await createUserAndLogin(ctx, {
      role: Role.ADMIN,
      organization: { timezone: 'Asia/Riyadh' },
    });
    const siteId = (await seedSite(ctx, admin.organization.id, { name: LONG_SITE_NAME })).id;

    const organizationId = admin.organization.id;
    const users = Array.from({ length: CROWD }, (_, i) => {
      const n = String(i).padStart(3, '0');
      return {
        id: randomUUID(),
        organizationId,
        email: `stall.subject.number.${n}.${LONG_NAME_PAD.toLowerCase().replace(/ /g, '.')}@wasel.test`,
        passwordHash: 'not-a-real-hash-these-users-never-sign-in',
        fullName: `Stall Subject Number ${n} ${LONG_NAME_PAD}`,
        employeeCode: `STL-${n}`,
        role: Role.MEMBER,
      };
    });
    await ctx.prisma.user.createMany({ data: users });
    await ctx.prisma.attendanceRecord.createMany({
      data: users.flatMap((user) =>
        Array.from({ length: DAYS }, (_, day) => {
          const date = workDay(day);
          return {
            organizationId,
            userId: user.id,
            workDate: new Date(`${date}T00:00:00.000Z`),
            checkInAt: new Date(`${date}T05:15:00.000Z`),
            checkInSiteId: siteId,
            checkInLatitude: 24.7136,
            checkInLongitude: 46.6753,
            checkInAccuracyM: 12,
            checkInDistanceM: 20,
            checkOutAt: new Date(`${date}T14:30:00.000Z`),
            checkOutSiteId: siteId,
            checkOutLatitude: 24.7136,
            checkOutLongitude: 46.6753,
            checkOutAccuracyM: 12,
            checkOutDistanceM: 20,
            status: AttendanceStatus.PRESENT,
            workedMinutes: 555,
            lateMinutes: 0,
          };
        }),
      ),
    });
  });

  it('lets go of a connection the client opened and never read', async () => {
    const started = Date.now();
    const download = openExport(ctx, admin.accessToken);
    const response = await download.headers;
    // Never read. The receive buffer fills, the peer's window closes, and the
    // server's writes stop completing — a live connection making no progress,
    // which is the one thing TCP will happily sustain forever.

    const audit = await waitForAudit(ctx, admin.organization.id, 'admin.report.export_failed');
    const elapsed = Date.now() - started;

    // The export gave up on its own, within its budget, rather than holding the
    // socket and the in-flight request for the life of the process.
    expect(elapsed).toBeGreaterThanOrEqual(STALL_BUDGET_MS);
    expect(elapsed).toBeLessThan(STALL_BUDGET_MS * 4);
    // Told apart from a client that hung up: this one never went away, it simply
    // never read. Different operational event, different remedy.
    expect(audit.metadata).toMatchObject({ reason: 'client_stalled', format: 'csv' });

    const logs = await ctx.logs.waitFor((log) => String(log.msg).includes('stopped reading'));
    expect(logs.length).toBeGreaterThan(0);

    // And what the client is left with, once it finally reads, is a truncated
    // transfer it must discard — not a short file it would mistake for the
    // month's payroll.
    const drained = await download.drain(response);
    expect(drained.completed).toBe(false);
    expect(drained.received).toBeGreaterThan(0);
  }, 60_000);

  it('never fires on a download that is slow but still moving', async () => {
    // 32 kB every 100 ms — about 320 kB/s, a poor link — sustained for twice the
    // stall budget. This is the download a total-duration limit would kill, and it
    // is exactly the year-end payroll extract.
    const started = Date.now();
    const download = openExport(ctx, admin.accessToken);
    const result = await download.drain(await download.headers, {
      everyMs: 100,
      bytes: 32 * 1024,
    });
    const elapsed = Date.now() - started;

    expect(result.completed).toBe(true);
    expect(result.received).toBeGreaterThan(3_000_000);
    // The proof that the budget is idle time and not elapsed time: this download
    // outlived it and was never touched.
    expect(elapsed).toBeGreaterThan(STALL_BUDGET_MS);

    const actions = (
      await ctx.prisma.auditLog.findMany({
        where: { organizationId: admin.organization.id },
        select: { action: true },
      })
    ).map((row) => row.action);
    expect(actions).toContain('admin.report.exported');
    expect(actions).not.toContain('admin.report.export_failed');
  }, 120_000);
});

interface DrainResult {
  received: number;
  completed: boolean;
}

interface OpenDownload {
  headers: Promise<IncomingMessage>;
  drain(response: IncomingMessage, pace?: { everyMs: number; bytes: number }): Promise<DrainResult>;
}

/**
 * Opens the export over a real socket and hands back a **paused** response.
 *
 * `node:http` rather than supertest, and paused rather than flowing: supertest
 * consumes a response as fast as it arrives, which is the one reading pattern that
 * can never reproduce a stall. `accept-encoding: identity` keeps the compression
 * middleware out of it so the byte counts mean what they say.
 *
 * The pause is also why the assertions are made server-side. A client whose socket
 * is genuinely not being read has stopped reading *at the kernel*, so it cannot
 * observe the reset either — it finds out when it next reads, which is precisely
 * the situation being tested.
 */
function openExport(ctx: TestApp, token: string): OpenDownload {
  const server = ctx.app.getHttpServer() as Server;
  const listening = server.listening
    ? Promise.resolve()
    : new Promise<void>((resolve) => server.listen(0, resolve));

  const headers = listening.then(
    () =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('server is not listening'));
          return;
        }
        const request = http.get(
          {
            port: address.port,
            path: `/api/v1/admin/reports/export?${RANGE}&format=csv`,
            headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity' },
          },
          (response) => {
            response.pause();
            resolve(response);
          },
        );
        request.on('error', reject);
      }),
  );

  const drain = (
    response: IncomingMessage,
    pace?: { everyMs: number; bytes: number },
  ): Promise<DrainResult> =>
    new Promise<DrainResult>((resolve) => {
      let received = 0;
      let timer: NodeJS.Timeout | null = null;
      const settle = (completed: boolean): void => {
        if (timer !== null) clearInterval(timer);
        timer = null;
        resolve({ received, completed });
      };

      response.on('end', () => settle(true));
      // A destroyed socket reaches a reading client as one of these, depending on
      // whether the reset arrives before or after the buffered bytes.
      response.on('aborted', () => settle(false));
      response.on('error', () => settle(false));
      response.on('close', () => {
        if (!response.complete) settle(false);
      });

      if (pace === undefined) {
        response.resume();
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
        });
        return;
      }
      timer = setInterval(() => {
        const chunk = response.read(pace.bytes) as Buffer | null;
        if (chunk !== null) received += chunk.length;
      }, pace.everyMs);
      timer.unref();
    });

  return { headers, drain };
}

/** Polls for `action`; the audit write lands just after the response is over. */
async function waitForAudit(
  ctx: TestApp,
  organizationId: string,
  action: string,
): Promise<{ action: string; metadata: unknown }> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const row = await ctx.prisma.auditLog.findFirst({
      where: { organizationId, action },
      select: { action: true, metadata: true },
    });
    if (row !== null) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the audit action "${action}"`);
}
