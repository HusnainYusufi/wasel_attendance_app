import { DateTime } from 'luxon';

/**
 * Time helpers shared by the dashboard, the report and the export.
 *
 * Everything here is explicit about which of the three kinds of value it is
 * handling, because conflating them is how attendance systems get midnight
 * wrong:
 *
 *  * an **instant** (`checkInAt`) — a `timestamptz`, absolute, zone-free;
 *  * a **calendar day** (`workDate`) — a `date`, meaningful only in the
 *    organization's zone, materialised by the driver as midnight UTC;
 *  * a **wall clock** — what a human in that organization saw on the clock, and
 *    the only rendering an attendance sheet should ever show.
 */

function requireValid(value: DateTime, what: string): DateTime {
  if (!value.isValid) {
    throw new TypeError(`${what}: ${value.invalidReason ?? 'invalid'}`);
  }
  return value;
}

/**
 * A `@db.Date` column as `YYYY-MM-DD`.
 *
 * Read in UTC, which is correct here and nowhere else: the column is a calendar
 * `date` and the driver hands it back as midnight UTC, so reading it in the
 * server's own zone would shift it a day for any host west of Greenwich.
 */
export function toIsoDate(value: Date): string {
  const iso = requireValid(DateTime.fromJSDate(value, { zone: 'utc' }), 'Invalid date').toISODate();
  if (iso === null) throw new TypeError('Invalid date');
  return iso;
}

/** `YYYY-MM-DD` → the midnight-UTC `Date` a `date` column compares against. */
export function fromIsoDate(value: string): Date {
  return requireValid(DateTime.fromISO(value, { zone: 'utc' }), `Not an ISO date: ${value}`)
    .startOf('day')
    .toJSDate();
}

/** An instant as the wall clock read in `zone`, e.g. `2026-03-01 08:47`. */
export function formatWallClock(instant: Date, zone: string): string {
  return requireValid(
    DateTime.fromJSDate(instant, { zone }),
    `Invalid organization timezone: ${zone}`,
  ).toFormat('yyyy-LL-dd HH:mm');
}

/**
 * An instant as a `Date` whose **UTC** fields carry the wall clock in `zone`.
 *
 * This exists because the xlsx format has no concept of a timezone: a date cell
 * is a serial number of days since 1900, and ExcelJS derives it straight from
 * `Date.getTime()`. Handing it the real instant would render Riyadh's 08:47 as
 * 05:47 for every reader. Relabelling the local wall clock as UTC — Luxon's
 * `keepLocalTime` — makes the cell display exactly what the employee's clock
 * said, while remaining a real date cell that Excel can sort, filter and
 * subtract.
 */
export function toSpreadsheetDate(instant: Date, zone: string): Date {
  return requireValid(
    DateTime.fromJSDate(instant, { zone }),
    `Invalid organization timezone: ${zone}`,
  )
    .setZone('utc', { keepLocalTime: true })
    .toJSDate();
}

/** Whole minutes as `h:mm`, for a human-readable total. */
export function formatDuration(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(safe / 60);
  return `${hours}:${String(safe % 60).padStart(2, '0')}`;
}
