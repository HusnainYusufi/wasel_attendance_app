import { describe, expect, it } from 'vitest';
import {
  ReminderKind,
  reminderKindSchema,
  reminderScheduleSchema,
  shiftReminderSchema,
} from '../reminders.js';

const RECORD_ID = '3f1d9b6e-7c2a-4f0d-9a11-000000000001';

const reminder = (overrides: Record<string, unknown> = {}) => ({
  id: `${RECORD_ID}:${ReminderKind.CHECKOUT_SOON}`,
  at: '2026-03-10T14:46:00.000Z',
  kind: ReminderKind.CHECKOUT_SOON,
  title: "Don't forget to check out",
  body: 'Your workday ends at 18:00. Tap to check out.',
  ...overrides,
});

describe('reminderKindSchema', () => {
  it('accepts exactly the two kinds the product asked for', () => {
    expect(Object.values(ReminderKind)).toEqual(['STILL_THERE', 'CHECKOUT_SOON']);
    expect(reminderKindSchema.safeParse('STILL_THERE').success).toBe(true);
    expect(reminderKindSchema.safeParse('CHECKOUT_SOON').success).toBe(true);
  });

  it('rejects a kind the client would not know how to render', () => {
    expect(reminderKindSchema.safeParse('OVERDUE').success).toBe(false);
  });
});

describe('shiftReminderSchema', () => {
  it('accepts a complete reminder', () => {
    expect(shiftReminderSchema.parse(reminder())).toEqual(reminder());
  });

  it.each(['id', 'title', 'body'])('rejects an empty %s', (field) => {
    // An empty title or body is a notification with nothing in it; an empty id
    // is one the client cannot recognise on a re-fetch.
    expect(shiftReminderSchema.safeParse(reminder({ [field]: '' })).success).toBe(false);
  });

  it('rejects a reminder with no instant', () => {
    const { at: _at, ...withoutAt } = reminder();
    expect(shiftReminderSchema.safeParse(withoutAt).success).toBe(false);
  });
});

describe('reminderScheduleSchema', () => {
  it('accepts an empty plan, which is what a checked-out shift returns', () => {
    const parsed = reminderScheduleSchema.parse({
      serverTime: '2026-03-10T06:13:00.000Z',
      reminders: [],
    });

    expect(parsed.reminders).toEqual([]);
  });

  it('accepts a full plan', () => {
    const parsed = reminderScheduleSchema.parse({
      serverTime: '2026-03-10T06:13:00.000Z',
      reminders: [
        reminder({ kind: ReminderKind.STILL_THERE, id: `${RECORD_ID}:STILL_THERE` }),
        reminder(),
      ],
    });

    expect(parsed.reminders.map((entry) => entry.kind)).toEqual([
      ReminderKind.STILL_THERE,
      ReminderKind.CHECKOUT_SOON,
    ]);
  });

  it('requires the reminders list rather than treating it as optional', () => {
    // A missing list and an empty list would mean the same thing to a careless
    // client — "nothing to do" — and opposite things to a careful one.
    expect(
      reminderScheduleSchema.safeParse({ serverTime: '2026-03-10T06:13:00.000Z' }).success,
    ).toBe(false);
  });
});
