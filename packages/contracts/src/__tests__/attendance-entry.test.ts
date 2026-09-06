import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_NOTE_MAX_LENGTH,
  AttendanceSource,
  attendanceEntrySchema,
  attendanceNoteSchema,
  createAttendanceEntryRequestSchema,
  listAttendanceEntriesQuerySchema,
  updateAttendanceEntryRequestSchema,
} from '../attendance-entry.js';
import { EXPORT_MAX_RANGE_DAYS } from '../constants.js';

const USER = '55555555-5555-4555-8555-555555555555';

const CREATE = {
  userId: USER,
  workDate: '2026-03-02',
  checkInTime: '08:00',
  checkOutTime: '17:00',
  checkOutNextDay: false,
  note: 'Phone battery died before the check-out',
};

describe('attendanceNoteSchema', () => {
  it('trims, because a note of three spaces is not a reason', () => {
    expect(attendanceNoteSchema.safeParse('   ').success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short to say anything', 'ok'],
    ['past the column width', 'x'.repeat(ATTENDANCE_NOTE_MAX_LENGTH + 1)],
  ])('rejects a note that is %s', (_label, value) => {
    expect(attendanceNoteSchema.safeParse(value).success).toBe(false);
  });

  it('accepts a note exactly as long as the column', () => {
    const note = 'x'.repeat(ATTENDANCE_NOTE_MAX_LENGTH);
    expect(attendanceNoteSchema.parse(note)).toBe(note);
  });
});

describe('createAttendanceEntryRequestSchema', () => {
  it('accepts a plain day', () => {
    expect(createAttendanceEntryRequestSchema.parse(CREATE)).toMatchObject({
      workDate: '2026-03-02',
      checkInTime: '08:00',
      checkOutTime: '17:00',
    });
  });

  it('accepts a day left open, which is what an INCOMPLETE record is', () => {
    const parsed = createAttendanceEntryRequestSchema.parse({
      ...CREATE,
      checkOutTime: null,
      checkOutNextDay: false,
    });
    expect(parsed.checkOutTime).toBeNull();
  });

  it('accepts an overnight shift when it is declared as one', () => {
    const parsed = createAttendanceEntryRequestSchema.parse({
      ...CREATE,
      checkInTime: '23:50',
      checkOutTime: '00:10',
      checkOutNextDay: true,
    });
    expect(parsed.checkOutNextDay).toBe(true);
  });

  it('refuses a check-out earlier in the day than the check-in', () => {
    const result = createAttendanceEntryRequestSchema.safeParse({
      ...CREATE,
      checkInTime: '17:00',
      checkOutTime: '08:00',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['checkOutTime']);
  });

  it('leaves a zero-length day to the server, which owns the minimum shift', () => {
    // Equal times are *accepted here* on purpose: the minimum shift length is
    // `MIN_SHIFT_MS` in the attendance module, and a copy of that rule in this
    // file would be the one that never learned the minimum had moved. The API
    // answers this request with `SHIFT_TOO_SHORT`.
    expect(
      createAttendanceEntryRequestSchema.safeParse({
        ...CREATE,
        checkInTime: '08:00',
        checkOutTime: '08:00',
      }).success,
    ).toBe(true);
  });

  it('refuses a day that has no check-out but claims to end tomorrow', () => {
    const result = createAttendanceEntryRequestSchema.safeParse({
      ...CREATE,
      checkOutTime: null,
      checkOutNextDay: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['checkOutNextDay']);
  });

  it.each([
    ['a note', { note: undefined }],
    ['a work date', { workDate: undefined }],
    ['a check-in', { checkInTime: undefined }],
    ['the overnight flag', { checkOutNextDay: undefined }],
  ])('will not accept a request missing %s', (_label, patch) => {
    expect(createAttendanceEntryRequestSchema.safeParse({ ...CREATE, ...patch }).success).toBe(
      false,
    );
  });

  it.each(['8:00', '24:00', '08:60', '08:00:00', 'morning'])(
    'rejects %j as a wall clock',
    (value) => {
      expect(
        createAttendanceEntryRequestSchema.safeParse({ ...CREATE, checkInTime: value }).success,
      ).toBe(false);
    },
  );

  it('rejects a work date that is not a calendar date', () => {
    expect(
      createAttendanceEntryRequestSchema.safeParse({ ...CREATE, workDate: '2026-03-02T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});

describe('updateAttendanceEntryRequestSchema', () => {
  it('always requires a reason, even when only the times move', () => {
    expect(updateAttendanceEntryRequestSchema.safeParse({ checkOutTime: '17:30' }).success).toBe(
      false,
    );
  });

  it('accepts a note on its own — annotating a record is a correction too', () => {
    expect(updateAttendanceEntryRequestSchema.parse({ note: 'Approved by payroll' })).toEqual({
      note: 'Approved by payroll',
    });
  });

  it('distinguishes "leave the check-out alone" from "clear it"', () => {
    const untouched = updateAttendanceEntryRequestSchema.parse({ note: 'Fixed the check-in' });
    expect(untouched.checkOutTime).toBeUndefined();

    const reopened = updateAttendanceEntryRequestSchema.parse({
      note: 'Never actually left',
      checkOutTime: null,
    });
    expect(reopened.checkOutTime).toBeNull();
  });

  it('refuses the overnight flag without the time it modifies', () => {
    const result = updateAttendanceEntryRequestSchema.safeParse({
      note: 'Night shift',
      checkOutNextDay: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['checkOutNextDay']);
  });

  it('refuses the overnight flag against a cleared check-out', () => {
    expect(
      updateAttendanceEntryRequestSchema.safeParse({
        note: 'Night shift',
        checkOutTime: null,
        checkOutNextDay: true,
      }).success,
    ).toBe(false);
  });
});

describe('listAttendanceEntriesQuerySchema', () => {
  it('coerces the page numbers a query string delivers as text', () => {
    const parsed = listAttendanceEntriesQuerySchema.parse({
      from: '2026-03-01',
      to: '2026-03-31',
      page: '2',
      pageSize: '10',
    });
    expect(parsed).toMatchObject({ page: 2, pageSize: 10 });
  });

  it('rejects a reversed range', () => {
    expect(
      listAttendanceEntriesQuerySchema.safeParse({ from: '2026-03-31', to: '2026-03-01' }).success,
    ).toBe(false);
  });

  it(`rejects a range longer than ${EXPORT_MAX_RANGE_DAYS} days`, () => {
    expect(
      listAttendanceEntriesQuerySchema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success,
    ).toBe(false);
  });

  it('filters to one source', () => {
    const parsed = listAttendanceEntriesQuerySchema.parse({
      from: '2026-03-01',
      to: '2026-03-31',
      source: AttendanceSource.MANUAL,
    });
    expect(parsed.source).toBe('MANUAL');
  });

  it('will not accept a source that does not exist', () => {
    expect(
      listAttendanceEntriesQuerySchema.safeParse({
        from: '2026-03-01',
        to: '2026-03-31',
        source: 'IMPORTED',
      }).success,
    ).toBe(false);
  });
});

describe('attendanceEntrySchema', () => {
  const PUNCHED = {
    id: '33333333-3333-4333-8333-333333333333',
    userId: USER,
    userFullName: 'Ahmed Al-Otaibi',
    userEmail: 'ahmed@example.com',
    employeeCode: 'EMP-1',
    workDate: '2026-03-02',
    checkInAt: '2026-03-02T05:00:00.000Z',
    checkOutAt: '2026-03-02T14:00:00.000Z',
    status: 'PRESENT',
    workedMinutes: 540,
    lateMinutes: 0,
    source: AttendanceSource.PUNCH,
    enteredBy: null,
    enteredAt: null,
    note: null,
  };

  it('carries provenance on a punched row too, so absence is never the signal', () => {
    const parsed = attendanceEntrySchema.parse(PUNCHED);
    expect(parsed.source).toBe('PUNCH');
    expect(parsed.enteredBy).toBeNull();
  });

  it('names the administrator behind a manual row', () => {
    const parsed = attendanceEntrySchema.parse({
      ...PUNCHED,
      source: AttendanceSource.MANUAL,
      enteredBy: { id: '44444444-4444-4444-8444-444444444444', fullName: 'Sara Admin' },
      enteredAt: '2026-03-03T06:00:00.000Z',
      note: 'Forgot to check out',
    });
    expect(parsed.enteredBy?.fullName).toBe('Sara Admin');
    expect(parsed.note).toBe('Forgot to check out');
  });

  it('will not carry a source that does not exist', () => {
    expect(attendanceEntrySchema.safeParse({ ...PUNCHED, source: 'IMPORTED' }).success).toBe(false);
  });

  it('requires every provenance field to be present, even as null', () => {
    const { source: _source, ...withoutSource } = PUNCHED;
    expect(attendanceEntrySchema.safeParse(withoutSource).success).toBe(false);
  });
});
