import { ReminderKind, type ShiftReminder } from '@wasel/contracts';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  MIN_REMINDER_SPACING_MS,
  expectedCheckOutInstant,
  planShiftReminders,
  type ShiftReminderInput,
} from '../reminder-plan.js';

const RIYADH = 'Asia/Riyadh';
const LOS_ANGELES = 'America/Los_Angeles';

/** A record id that looks like the uuid the database actually issues. */
const RECORD = '3f1d9b6e-7c2a-4f0d-9a11-000000000001';

const wall = (iso: string, zone: string): Date => DateTime.fromISO(iso, { zone }).toJSDate();

/** A 09:00–18:00 tenant in Riyadh, the shape of the overwhelming majority. */
function dayShift(overrides: Partial<ShiftReminderInput> = {}): ShiftReminderInput {
  return {
    attendanceRecordId: RECORD,
    checkInAt: wall('2026-03-10T09:12', RIYADH),
    now: wall('2026-03-10T09:13', RIYADH),
    workDate: '2026-03-10',
    timezone: RIYADH,
    workdayStart: '09:00',
    workdayEnd: '18:00',
    dayStartsAt: '00:00',
    ...overrides,
  };
}

const kinds = (plan: ShiftReminder[]): string[] => plan.map((reminder) => reminder.kind);
const instants = (plan: ShiftReminder[]): number[] => plan.map((r) => Date.parse(r.at));
const localTimes = (plan: ShiftReminder[], zone: string): string[] =>
  plan.map((r) => DateTime.fromISO(r.at, { zone }).toFormat('yyyy-MM-dd HH:mm'));

describe('planShiftReminders — the ordinary day', () => {
  it('plans both reminders for a 09:12 check-in against an 18:00 workday end', () => {
    const plan = planShiftReminders(dayShift());

    expect(kinds(plan)).toEqual([ReminderKind.STILL_THERE, ReminderKind.CHECKOUT_SOON]);
    expect(localTimes(plan, RIYADH)).toEqual(['2026-03-10 13:30', '2026-03-10 17:46']);
  });

  it('keeps every reminder strictly inside the shift', () => {
    const input = dayShift();
    const end = expectedCheckOutInstant(input).getTime();

    for (const at of instants(planShiftReminders(input))) {
      expect(at).toBeGreaterThan(input.checkInAt.getTime());
      expect(at).toBeLessThan(end);
    }
  });

  it('orders them earliest first and spaces them by at least the minimum gap', () => {
    const [first, second] = instants(planShiftReminders(dayShift()));

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second as number).toBeGreaterThanOrEqual((first as number) + MIN_REMINDER_SPACING_MS);
  });

  it('lands on whole minutes, so a notification never arrives at 17:33:27', () => {
    for (const at of instants(planShiftReminders(dayShift()))) {
      expect(at % 60_000).toBe(0);
    }
  });

  it('writes the times in the copy in the organization timezone', () => {
    const [still, soon] = planShiftReminders(dayShift());

    expect(still?.body).toContain('09:12');
    expect(soon?.body).toContain('18:00');
    expect(soon?.title).toBe("Don't forget to check out");
    expect(still?.title).toBe('Are you still there?');
  });
});

describe('planShiftReminders — determinism', () => {
  it('returns identical instants when the same shift is asked twice', () => {
    const input = dayShift();

    expect(planShiftReminders(input)).toEqual(planShiftReminders(input));
  });

  it('returns identical instants across a hundred calls', () => {
    const input = dayShift();
    const first = JSON.stringify(planShiftReminders(input));

    for (let call = 0; call < 100; call += 1) {
      expect(JSON.stringify(planShiftReminders(input))).toBe(first);
    }
  });

  it('does not move an instant when the clock advances — it only drops what has passed', () => {
    // The client re-fetches on every resume and token refresh. If the times
    // drifted with `now`, each fetch would schedule a *different* pair and the
    // device would accumulate duplicates that fire later and later.
    const morning = planShiftReminders(dayShift({ now: wall('2026-03-10T09:13', RIYADH) }));
    const noon = planShiftReminders(dayShift({ now: wall('2026-03-10T11:59', RIYADH) }));
    const afternoon = planShiftReminders(dayShift({ now: wall('2026-03-10T14:00', RIYADH) }));

    expect(noon).toEqual(morning);
    expect(kinds(afternoon)).toEqual([ReminderKind.CHECKOUT_SOON]);
    expect(afternoon[0]).toEqual(morning[1]);
  });

  it('gives the same shift the same ids, so a re-fetch is recognisable', () => {
    expect(planShiftReminders(dayShift()).map((r) => r.id)).toEqual([
      `${RECORD}:STILL_THERE`,
      `${RECORD}:CHECKOUT_SOON`,
    ]);
  });

  it('is seeded per record, so two people on the same shift are nudged at different times', () => {
    const a = planShiftReminders(dayShift({ attendanceRecordId: RECORD }));
    const b = planShiftReminders(
      dayShift({ attendanceRecordId: '9c4a2210-1111-4222-8333-0000000000ff' }),
    );

    expect(instants(a)).not.toEqual(instants(b));
    // …and the jitter is real rather than a constant offset: the two plans
    // differ in the middle reminder by more than a rounding artefact.
    expect(Math.abs((instants(a)[0] as number) - (instants(b)[0] as number))).toBeGreaterThan(
      60_000,
    );
  });

  it('spreads a hundred records across the band instead of clustering', () => {
    const middles: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const plan = planShiftReminders(
        dayShift({
          attendanceRecordId: `3f1d9b6e-7c2a-4f0d-9a11-${String(index).padStart(12, '0')}`,
        }),
      );
      middles.push(Date.parse(plan[0]?.at ?? ''));
    }

    // The band is 158 minutes wide, so 100 draws land on ~74 distinct minutes
    // once collisions are accounted for. A constant seed would collapse this to
    // one value, and a weakly mixed one would cluster in a corner of the band.
    expect(new Set(middles).size).toBeGreaterThan(60);
    expect(Math.max(...middles) - Math.min(...middles)).toBeGreaterThan(140 * 60_000);
  });
});

describe('planShiftReminders — every record still gets at least two nudges on a normal day', () => {
  it('plans two, ordered and spaced, for two hundred different records', () => {
    for (let index = 0; index < 200; index += 1) {
      const input = dayShift({
        attendanceRecordId: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`,
      });
      const plan = planShiftReminders(input);
      const end = expectedCheckOutInstant(input).getTime();

      expect(kinds(plan)).toEqual([ReminderKind.STILL_THERE, ReminderKind.CHECKOUT_SOON]);
      const [first, second] = instants(plan);
      expect(first as number).toBeGreaterThan(input.checkInAt.getTime());
      expect(second as number).toBeLessThan(end);
      expect((second as number) - (first as number)).toBeGreaterThanOrEqual(
        MIN_REMINDER_SPACING_MS,
      );
    }
  });
});

describe('planShiftReminders — a window too short for two', () => {
  it('sends one reminder, the actionable one, for a 17:50 check-in against an 18:00 end', () => {
    const plan = planShiftReminders(
      dayShift({
        checkInAt: wall('2026-03-10T17:50', RIYADH),
        now: wall('2026-03-10T17:51', RIYADH),
      }),
    );

    expect(kinds(plan)).toEqual([ReminderKind.CHECKOUT_SOON]);
    expect(localTimes(plan, RIYADH)).toEqual(['2026-03-10 17:58']);
  });

  it('drops to one the moment the gap would fall under the minimum spacing', () => {
    // 80 minutes left: the two bands are still ordered, but too close together
    // to read as two separate prompts.
    const cramped = planShiftReminders(
      dayShift({
        checkInAt: wall('2026-03-10T16:40', RIYADH),
        now: wall('2026-03-10T16:41', RIYADH),
      }),
    );
    // 120 minutes left: comfortably two.
    const roomy = planShiftReminders(
      dayShift({
        checkInAt: wall('2026-03-10T16:00', RIYADH),
        now: wall('2026-03-10T16:01', RIYADH),
      }),
    );

    expect(kinds(cramped)).toEqual([ReminderKind.CHECKOUT_SOON]);
    expect(kinds(roomy)).toEqual([ReminderKind.STILL_THERE, ReminderKind.CHECKOUT_SOON]);
  });

  it('says nothing at all when there is no usable window left', () => {
    const plan = planShiftReminders(
      dayShift({
        checkInAt: wall('2026-03-10T17:57', RIYADH),
        now: wall('2026-03-10T17:58', RIYADH),
      }),
    );

    expect(plan).toEqual([]);
  });
});

describe('planShiftReminders — check-in after the workday end', () => {
  it('treats an evening arrival as a nominal-length shift starting on arrival', () => {
    const input = dayShift({
      checkInAt: wall('2026-03-10T19:30', RIYADH),
      now: wall('2026-03-10T19:31', RIYADH),
    });

    // The tenant's own day is nine hours long, so the expected check-out is
    // 19:30 + 9h — not 18:00, which has already gone, and not a hard-coded eight.
    expect(DateTime.fromJSDate(expectedCheckOutInstant(input), { zone: RIYADH }).toISO()).toContain(
      '2026-03-11T04:30',
    );
    expect(kinds(planShiftReminders(input))).toEqual([
      ReminderKind.STILL_THERE,
      ReminderKind.CHECKOUT_SOON,
    ]);
  });

  it('uses the tenant’s own day length rather than a fixed eight hours', () => {
    const shortDay = dayShift({
      workdayStart: '08:00',
      workdayEnd: '14:00',
      checkInAt: wall('2026-03-10T15:00', RIYADH),
      now: wall('2026-03-10T15:01', RIYADH),
    });

    expect(expectedCheckOutInstant(shortDay).toISOString()).toBe(
      wall('2026-03-10T21:00', RIYADH).toISOString(),
    );
  });

  it('falls back to eight hours when the policy cannot supply a length', () => {
    // `workdayStart === workdayEnd` yields a zero-length day; a night tenant that
    // has left `dayStartsAt` at midnight yields a negative one. Neither may take
    // reminders down with it.
    const degenerate = dayShift({
      workdayStart: '09:00',
      workdayEnd: '09:00',
      checkInAt: wall('2026-03-10T10:00', RIYADH),
      now: wall('2026-03-10T10:01', RIYADH),
    });
    const inverted = dayShift({
      workdayStart: '22:00',
      workdayEnd: '06:00',
      checkInAt: wall('2026-03-10T22:05', RIYADH),
      now: wall('2026-03-10T22:06', RIYADH),
    });

    expect(expectedCheckOutInstant(degenerate).toISOString()).toBe(
      wall('2026-03-10T18:00', RIYADH).toISOString(),
    );
    expect(expectedCheckOutInstant(inverted).toISOString()).toBe(
      wall('2026-03-11T06:05', RIYADH).toISOString(),
    );
  });
});

describe('planShiftReminders — nothing in the past, nothing after the day is over', () => {
  it('drops a reminder whose instant has already passed', () => {
    const plan = planShiftReminders(dayShift({ now: wall('2026-03-10T17:00', RIYADH) }));

    expect(kinds(plan)).toEqual([ReminderKind.CHECKOUT_SOON]);
  });

  it('returns nothing once the expected check-out is behind us', () => {
    // Somebody who blew past their own workday end is a different problem — an
    // overdue nag would have to repeat, and this endpoint deliberately plans
    // only what is due *before* the expected check-out.
    expect(planShiftReminders(dayShift({ now: wall('2026-03-10T19:00', RIYADH) }))).toEqual([]);
  });

  it('never returns an instant at or before `now`', () => {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = new Date(wall('2026-03-10T00:00', RIYADH).getTime() + minute * 60_000);
      for (const at of instants(planShiftReminders(dayShift({ now })))) {
        expect(at).toBeGreaterThan(now.getTime());
      }
    }
  });
});

describe('planShiftReminders — timezones', () => {
  it('resolves the workday end in the organization zone, not UTC (positive offset)', () => {
    const plan = planShiftReminders(dayShift());

    // 18:00 in Riyadh is 15:00Z. A UTC reading would have placed the "soon"
    // reminder three hours late, after everybody had gone home.
    expect(plan[1]?.at.endsWith('Z')).toBe(true);
    expect(Date.parse(plan[1]?.at ?? '')).toBeLessThan(Date.parse('2026-03-10T15:00:00.000Z'));
    expect(Date.parse(plan[1]?.at ?? '')).toBeGreaterThan(Date.parse('2026-03-10T14:00:00.000Z'));
  });

  it('resolves it in a negative-offset zone too', () => {
    const input = dayShift({
      timezone: LOS_ANGELES,
      checkInAt: wall('2026-03-10T09:12', LOS_ANGELES),
      now: wall('2026-03-10T09:13', LOS_ANGELES),
    });

    // 18:00 in Los Angeles on 2026-03-10 (PDT, UTC-7) is 01:00Z on the 11th.
    expect(expectedCheckOutInstant(input).toISOString()).toBe('2026-03-11T01:00:00.000Z');
    expect(localTimes(planShiftReminders(input), LOS_ANGELES)).toEqual([
      '2026-03-10 13:30',
      '2026-03-10 17:46',
    ]);
  });

  it('follows a night tenant’s workday end onto the next calendar date', () => {
    const input: ShiftReminderInput = {
      attendanceRecordId: RECORD,
      checkInAt: wall('2026-03-10T23:10', LOS_ANGELES),
      now: wall('2026-03-10T23:11', LOS_ANGELES),
      workDate: '2026-03-10',
      timezone: LOS_ANGELES,
      workdayStart: '23:00',
      workdayEnd: '07:00',
      dayStartsAt: '20:00',
    };

    // The business day labelled 2026-03-10 runs 20:00 on the 10th to 20:00 on
    // the 11th, so its 07:00 end is on the 11th — the occurrence on the 10th
    // belongs to the *previous* business day.
    expect(
      DateTime.fromJSDate(expectedCheckOutInstant(input), { zone: LOS_ANGELES }).toFormat(
        'yyyy-MM-dd HH:mm',
      ),
    ).toBe('2026-03-11 07:00');
    expect(localTimes(planShiftReminders(input), LOS_ANGELES)).toEqual([
      '2026-03-11 03:00',
      '2026-03-11 06:46',
    ]);
  });

  it('places the reminders correctly on a spring-forward day', () => {
    // 2026-03-08 in Los Angeles: 02:00 never happens, the day is 23 hours long.
    const input = dayShift({
      timezone: LOS_ANGELES,
      workDate: '2026-03-08',
      checkInAt: wall('2026-03-08T09:00', LOS_ANGELES),
      now: wall('2026-03-08T09:01', LOS_ANGELES),
    });

    expect(expectedCheckOutInstant(input).toISOString()).toBe('2026-03-09T01:00:00.000Z');
    for (const at of instants(planShiftReminders(input))) {
      expect(at).toBeGreaterThan(input.checkInAt.getTime());
      expect(at).toBeLessThan(expectedCheckOutInstant(input).getTime());
    }
  });
});
