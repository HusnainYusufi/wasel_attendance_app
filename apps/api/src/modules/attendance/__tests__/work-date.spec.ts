import { describe, expect, it } from 'vitest';
import {
  businessDateIn,
  lateMinutesFor,
  minutesBetween,
  parseInstant,
  shiftWorkDate,
  wallClockInstant,
  workDateFromColumn,
  workDateIn,
  workDateToColumn,
  workdayStartInstant,
} from '../work-date.js';

const RIYADH = 'Asia/Riyadh';
const NEW_YORK = 'America/New_York';
/** The default boundary: local midnight, i.e. "a business day is a calendar day". */
const MIDNIGHT = '00:00';

describe('workDateIn', () => {
  it('uses the organization zone, not UTC, for a positive offset', () => {
    const instant = new Date('2026-03-01T22:30:00.000Z');

    // 01:30 on the 2nd in Riyadh (UTC+3). The naive implementation this replaces
    // reports the 1st and files the punch under the wrong day.
    expect(workDateIn(instant, RIYADH)).toBe('2026-03-02');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('uses the organization zone, not UTC, for a negative offset', () => {
    const instant = new Date('2026-03-02T02:30:00.000Z');

    // 21:30 on the 1st in New York (UTC-5): still yesterday's work day.
    expect(workDateIn(instant, NEW_YORK)).toBe('2026-03-01');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-03-02');
  });

  it.each([
    ['the last millisecond of a day', '2026-03-01T20:59:59.999Z', '2026-03-01'],
    ['the first millisecond of the next', '2026-03-01T21:00:00.000Z', '2026-03-02'],
  ])('rolls over at local midnight — %s', (_name, iso, expected) => {
    expect(workDateIn(new Date(iso), RIYADH)).toBe(expected);
  });

  it.each([
    ['the last second of a day', '2026-03-02T04:59:59.000Z', '2026-03-01'],
    ['the first second of the next', '2026-03-02T05:00:00.000Z', '2026-03-02'],
  ])('rolls over at local midnight in a negative offset — %s', (_name, iso, expected) => {
    expect(workDateIn(new Date(iso), NEW_YORK)).toBe(expected);
  });

  it('is stable across the hour a spring-forward day skips', () => {
    // 01:30 EST, then 03:30 EDT: the clock jumps but the calendar date does not.
    expect(workDateIn(new Date('2026-03-08T06:30:00.000Z'), NEW_YORK)).toBe('2026-03-08');
    expect(workDateIn(new Date('2026-03-08T07:30:00.000Z'), NEW_YORK)).toBe('2026-03-08');
  });

  it('is stable across the hour a fall-back day repeats', () => {
    // Both instants read 01:30 locally — once in EDT, once in EST.
    expect(workDateIn(new Date('2026-11-01T05:30:00.000Z'), NEW_YORK)).toBe('2026-11-01');
    expect(workDateIn(new Date('2026-11-01T06:30:00.000Z'), NEW_YORK)).toBe('2026-11-01');
  });

  it('refuses an unusable timezone rather than guessing UTC', () => {
    expect(() => workDateIn(new Date('2026-03-01T00:00:00.000Z'), 'Mars/Phobos')).toThrow(
      RangeError,
    );
  });
});

describe('shiftWorkDate', () => {
  it.each([
    ['across a month boundary', '2026-03-01', -1, '2026-02-28'],
    ['across a leap day', '2024-03-01', -1, '2024-02-29'],
    ['across a year boundary', '2026-01-01', -1, '2025-12-31'],
    ['forwards', '2026-02-28', 1, '2026-03-01'],
    ['across a spring-forward day', '2026-03-09', -1, '2026-03-08'],
  ])('steps %s', (_name, from, days, expected) => {
    expect(shiftWorkDate(from, days)).toBe(expected);
  });

  it('refuses a malformed work date', () => {
    expect(() => shiftWorkDate('not-a-date', -1)).toThrow(RangeError);
  });
});

describe('the @db.Date carrier', () => {
  it('round-trips a work date through the column encoding', () => {
    const column = workDateToColumn('2026-03-02');

    // Postgres `date` keeps only Y-M-D, and the driver hands it back at UTC
    // midnight; writing it the same way is what makes the round trip exact.
    expect(column.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(workDateFromColumn(column)).toBe('2026-03-02');
  });

  it('is unaffected by the zone the date was computed in', () => {
    const fromRiyadh = workDateIn(new Date('2026-03-01T22:30:00.000Z'), RIYADH);
    expect(workDateFromColumn(workDateToColumn(fromRiyadh))).toBe('2026-03-02');
  });
});

describe('wallClockInstant', () => {
  it('resolves a local start time to the right instant', () => {
    expect(wallClockInstant('2026-03-01', '09:00', RIYADH).toISOString()).toBe(
      '2026-03-01T06:00:00.000Z',
    );
  });

  it('applies the offset in force on that particular day', () => {
    // Same wall-clock time, one week apart, an hour apart in UTC: a hard-coded
    // -05:00 would put the second one at the wrong instant.
    expect(wallClockInstant('2026-03-01', '09:00', NEW_YORK).toISOString()).toBe(
      '2026-03-01T14:00:00.000Z',
    );
    expect(wallClockInstant('2026-03-08', '09:00', NEW_YORK).toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });

  it('resolves a wall-clock time the spring-forward day never reaches', () => {
    // 02:30 does not exist on 2026-03-08 in New York; the first moment it could
    // be observed is 03:30 EDT.
    expect(wallClockInstant('2026-03-08', '02:30', NEW_YORK).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it.each([['9:00'], ['24:00'], ['09:60'], ['0900'], ['']])(
    'refuses the malformed workday time %j',
    (value) => {
      expect(() => wallClockInstant('2026-03-01', value, RIYADH)).toThrow(RangeError);
    },
  );
});

describe('businessDateIn', () => {
  it.each([
    ['midday', '2026-03-01T09:00:00.000Z'],
    ['just before local midnight', '2026-03-01T20:59:00.000Z'],
    ['just after local midnight', '2026-03-01T21:01:00.000Z'],
  ])('is exactly the calendar date at the default boundary — %s', (_name, iso) => {
    // The default must be inert: every stored row was cut this way, and a
    // boundary that quietly re-partitions the day would restate paid history.
    const at = new Date(iso);
    expect(businessDateIn(at, RIYADH, MIDNIGHT)).toBe(workDateIn(at, RIYADH));
  });

  it('keeps a whole night on one business date for an evening boundary', () => {
    // 23:00, 23:10, 00:30 and 02:00 local across the 1st and the 2nd, for a
    // tenant whose day rolls over at 20:00. One shift, one date.
    const punches = [
      '2026-03-01T20:00:00.000Z',
      '2026-03-01T20:10:00.000Z',
      '2026-03-01T21:30:00.000Z',
      '2026-03-01T23:00:00.000Z',
    ].map((iso) => businessDateIn(new Date(iso), RIYADH, '20:00'));

    expect(punches).toEqual(['2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01']);
  });

  it('rolls over at the boundary, not at midnight', () => {
    // Business day D runs from `dayStartsAt` on D to `dayStartsAt` on D+1, so at
    // a 20:00 boundary 19:59 local on the 1st still belongs to the 28th, and
    // 20:00 is the first instant of the 1st.
    expect(businessDateIn(new Date('2026-03-01T16:59:00.000Z'), RIYADH, '20:00')).toBe(
      '2026-02-28',
    );
    expect(businessDateIn(new Date('2026-03-01T17:00:00.000Z'), RIYADH, '20:00')).toBe(
      '2026-03-01',
    );
  });

  it('files an early arrival under today, not yesterday', () => {
    // 08:00 local with a 04:00 boundary. The rule is "the day starts at
    // `dayStartsAt`", never "the day starts at `workdayStart`" — the latter
    // would back-date every keen arrival at a 09:00 office.
    expect(businessDateIn(new Date('2026-03-01T05:00:00.000Z'), RIYADH, '04:00')).toBe(
      '2026-03-01',
    );
  });

  it('crosses a month end backwards', () => {
    // 01:00 local on 1 March, boundary 06:00: the business day is 28 February.
    expect(businessDateIn(new Date('2026-02-28T22:00:00.000Z'), RIYADH, '06:00')).toBe(
      '2026-02-28',
    );
  });
});

describe('workdayStartInstant', () => {
  it('anchors on the workday start inside the business day, at the default boundary', () => {
    expect(
      workdayStartInstant({
        workDate: '2026-03-01',
        timezone: RIYADH,
        workdayStart: '09:00',
        dayStartsAt: MIDNIGHT,
      }).toISOString(),
    ).toBe('2026-03-01T06:00:00.000Z');
  });

  it('anchors a night shift on the evening the business day opened', () => {
    // Business day 2026-03-01 runs 20:00 on the 1st → 20:00 on the 2nd, so the
    // 23:00 start inside it is the one on the 1st.
    expect(
      workdayStartInstant({
        workDate: '2026-03-01',
        timezone: RIYADH,
        workdayStart: '23:00',
        dayStartsAt: '20:00',
      }).toISOString(),
    ).toBe('2026-03-01T20:00:00.000Z');
  });

  it('anchors on the following calendar date when the start is past the boundary', () => {
    // A 02:00 start under a 20:00 boundary: the occurrence inside business day
    // 2026-03-01 is 02:00 on the *2nd*.
    expect(
      workdayStartInstant({
        workDate: '2026-03-01',
        timezone: RIYADH,
        workdayStart: '02:00',
        dayStartsAt: '20:00',
      }).toISOString(),
    ).toBe('2026-03-01T23:00:00.000Z');
  });
});

describe('lateMinutesFor', () => {
  const base = {
    workDate: '2026-03-01',
    timezone: RIYADH,
    workdayStart: '09:00',
    dayStartsAt: MIDNIGHT,
    graceMinutes: 15,
  };

  it.each([
    ['before the workday starts', '2026-03-01T05:30:00.000Z', 0],
    ['exactly at the start', '2026-03-01T06:00:00.000Z', 0],
    ['inside the grace window', '2026-03-01T06:10:00.000Z', 0],
    ['exactly at the end of grace', '2026-03-01T06:15:00.000Z', 0],
    ['twelve minutes past grace', '2026-03-01T06:27:00.000Z', 12],
    ['an hour past grace', '2026-03-01T07:15:00.000Z', 60],
  ])('is %s → %i', (_name, iso, expected) => {
    expect(lateMinutesFor({ ...base, checkInAt: new Date(iso) })).toBe(expected);
  });

  it('rounds any overshoot up, so a LATE record always has a non-zero count', () => {
    // Flooring would report 0 for a check-in half a minute late, contradicting
    // the status derived from the same number and extending every organization's
    // grace by 59 seconds.
    expect(lateMinutesFor({ ...base, checkInAt: new Date('2026-03-01T06:15:30.000Z') })).toBe(1);
    expect(lateMinutesFor({ ...base, checkInAt: new Date('2026-03-01T06:15:00.001Z') })).toBe(1);
  });

  it('measures against the offset in force on a DST transition day', () => {
    // 10:30 EDT on the spring-forward day: 90 minutes after a 09:00 start, so 75
    // past a 15-minute grace. An implementation that froze the offset at EST
    // would read 09:30 and report 15.
    expect(
      lateMinutesFor({
        ...base,
        timezone: NEW_YORK,
        workDate: '2026-03-08',
        checkInAt: new Date('2026-03-08T14:30:00.000Z'),
      }),
    ).toBe(75);
  });

  it('honours a zero grace', () => {
    expect(
      lateMinutesFor({
        ...base,
        graceMinutes: 0,
        checkInAt: new Date('2026-03-01T06:05:00.000Z'),
      }),
    ).toBe(5);
  });

  describe('a night shift, whose grace window crosses local midnight', () => {
    // 23:00 start, no grace, day rolling over at 20:00 — the configuration the
    // boundary exists for. Before it existed, `workDate` was the calendar date
    // and the anchor jumped a full day at midnight, so the two punches after
    // midnight scored 0: being *more* late produced a better record.
    const night = {
      workDate: '2026-03-01',
      timezone: RIYADH,
      workdayStart: '23:00',
      dayStartsAt: '20:00',
      graceMinutes: 0,
    };

    it.each([
      ['on the hour', '2026-03-01T20:00:00.000Z', 0],
      ['ten past', '2026-03-01T20:10:00.000Z', 10],
      ['00:30, after midnight', '2026-03-01T21:30:00.000Z', 90],
      ['02:00, three hours in', '2026-03-01T23:00:00.000Z', 180],
    ])('%s → %i minutes late', (_name, iso, expected) => {
      expect(lateMinutesFor({ ...night, checkInAt: new Date(iso) })).toBe(expected);
    });
  });

  describe('the fall-back hour, when a wall-clock time happens twice', () => {
    // 2026-11-01 in New York: 01:00–02:00 EDT (−04:00) is repeated as 01:00–02:00
    // EST (−05:00). A `workdayStart` inside it is genuinely ambiguous.
    const ambiguous = {
      workDate: '2026-11-01',
      timezone: NEW_YORK,
      workdayStart: '01:30',
      dayStartsAt: MIDNIGHT,
      graceMinutes: 0,
    };

    it('pins the anchor to the first of the two readings', () => {
      expect(
        workdayStartInstant(ambiguous).toISOString(),
        // 01:30 EDT, not 01:30 EST. Choosing the later reading would move the
        // start of the workday an hour into the workday.
      ).toBe('2026-11-01T05:30:00.000Z');
    });

    it('scores two check-ins whose clocks both read 01:35 as 0 and 60', () => {
      // Not a bug to fix but an asymmetry to know about: the wall clock is not
      // injective that hour, so the two punches really are an hour apart and no
      // single anchor can make both read "on time".
      const first = lateMinutesFor({
        ...ambiguous,
        checkInAt: new Date('2026-11-01T05:35:00.000Z'),
      });
      const second = lateMinutesFor({
        ...ambiguous,
        checkInAt: new Date('2026-11-01T06:35:00.000Z'),
      });

      expect([first, second]).toEqual([5, 65]);
    });
  });
});

describe('minutesBetween', () => {
  it('rounds to the nearest minute', () => {
    expect(
      minutesBetween(new Date('2026-03-01T06:00:00.000Z'), new Date('2026-03-01T14:29:40.000Z')),
    ).toBe(510);
  });

  it('never reports negative time', () => {
    expect(
      minutesBetween(new Date('2026-03-01T14:00:00.000Z'), new Date('2026-03-01T06:00:00.000Z')),
    ).toBe(0);
  });

  it('spans a DST boundary in real elapsed time, not wall-clock hours', () => {
    // 01:00 EST → 04:00 EDT is two hours of clock face but three of elapsed time.
    expect(
      minutesBetween(new Date('2026-03-08T06:00:00.000Z'), new Date('2026-03-08T09:00:00.000Z')),
    ).toBe(180);
  });
});

describe('parseInstant', () => {
  it('keeps a device time that is wildly wrong, for tamper analysis', () => {
    expect(parseInstant('1900-01-01T00:00:00.000Z')?.toISOString()).toBe(
      '1900-01-01T00:00:00.000Z',
    );
  });

  it('preserves the instant an offset-bearing timestamp names', () => {
    expect(parseInstant('2026-03-01T09:00:00.000+03:00')?.toISOString()).toBe(
      '2026-03-01T06:00:00.000Z',
    );
  });

  it.each([[undefined], ['not-a-timestamp'], ['']])('yields null for %j', (value) => {
    expect(parseInstant(value)).toBeNull();
  });
});
