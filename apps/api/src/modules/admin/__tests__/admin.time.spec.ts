import { describe, expect, it } from 'vitest';
import { businessDateIn } from '../../attendance/work-date.js';
import {
  formatDuration,
  formatWallClock,
  fromIsoDate,
  toIsoDate,
  toSpreadsheetDate,
} from '../admin.time.js';

const RIYADH = 'Asia/Riyadh'; // UTC+3, no DST
const NEW_YORK = 'America/New_York'; // UTC-5/-4, DST

describe("the dashboard's notion of today", () => {
  // The admin dashboard once carried its own local-calendar-date helper. That was
  // correct only while every tenant's business day began at midnight; once
  // `dayStartsAt` existed, the dashboard would have counted a different day from
  // the one attendance filed punches under. These assertions now run against the
  // attendance module's single implementation, so the two cannot drift apart
  // again — a divergence that would be invisible except to whoever was paid wrong.

  it("rolls over at the tenant's midnight, not at the server's", () => {
    // 21:30 UTC is already the next day in Riyadh. `toISOString().slice(0, 10)`
    // — the bug this guards against — would answer the 14th.
    expect(businessDateIn(new Date('2026-03-14T21:30:00.000Z'), RIYADH, '00:00')).toBe(
      '2026-03-15',
    );
    expect(businessDateIn(new Date('2026-03-14T20:59:00.000Z'), RIYADH, '00:00')).toBe(
      '2026-03-14',
    );
  });

  it('rolls over correctly west of Greenwich too', () => {
    expect(businessDateIn(new Date('2026-03-15T02:00:00.000Z'), NEW_YORK, '00:00')).toBe(
      '2026-03-14',
    );
  });

  it('follows a non-midnight boundary, so a night shift counts as one day', () => {
    // 22:00 and 02:00 Riyadh straddle midnight but belong to the same business
    // day for a tenant whose day rolls over at 20:00.
    expect(businessDateIn(new Date('2026-03-14T19:00:00.000Z'), RIYADH, '20:00')).toBe(
      '2026-03-14',
    );
    expect(businessDateIn(new Date('2026-03-14T23:00:00.000Z'), RIYADH, '20:00')).toBe(
      '2026-03-14',
    );
  });

  it('refuses an invalid timezone rather than silently falling back to UTC', () => {
    expect(() =>
      businessDateIn(new Date('2026-03-14T21:30:00.000Z'), 'Mars/Olympus', '00:00'),
    ).toThrow();
  });
});

describe('toIsoDate / fromIsoDate', () => {
  it('round-trips a calendar date column', () => {
    const stored = fromIsoDate('2026-03-01');
    expect(stored.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(toIsoDate(stored)).toBe('2026-03-01');
  });

  it('rejects a value that is not an ISO date', () => {
    expect(() => fromIsoDate('01/03/2026')).toThrow(TypeError);
  });
});

describe('formatWallClock', () => {
  it('renders the clock the employee actually looked at', () => {
    expect(formatWallClock(new Date('2026-03-01T05:47:00.000Z'), RIYADH)).toBe('2026-03-01 08:47');
  });

  it('honours daylight saving where it applies', () => {
    // 2026-03-08 is the US spring-forward; 14:00 UTC is 10:00 EDT, not 09:00 EST.
    expect(formatWallClock(new Date('2026-03-09T14:00:00.000Z'), NEW_YORK)).toBe(
      '2026-03-09 10:00',
    );
  });
});

describe('toSpreadsheetDate', () => {
  it('relabels the local wall clock as UTC so Excel displays it unshifted', () => {
    // ExcelJS derives a cell's serial number straight from `getTime()`, and xlsx
    // has no timezone, so the wall clock has to be carried in the UTC fields.
    const cell = toSpreadsheetDate(new Date('2026-03-01T05:47:00.000Z'), RIYADH);
    expect(cell.toISOString()).toBe('2026-03-01T08:47:00.000Z');
  });

  it('is the identity for a UTC organization', () => {
    const instant = new Date('2026-03-01T05:47:00.000Z');
    expect(toSpreadsheetDate(instant, 'UTC').getTime()).toBe(instant.getTime());
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [59, '0:59'],
    [60, '1:00'],
    [496, '8:16'],
    [1_500, '25:00'],
  ])('renders %i minutes as %s', (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });
});
