import { AttendanceStatus } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { summarize } from '../admin-reports.service.js';
import { ExportTotals } from '../export/export-totals.js';
import { reportRecord } from './fixtures.js';

describe('ExportTotals', () => {
  it('is a valid, all-zero summary before anything is added', () => {
    expect(new ExportTotals().toSummary()).toEqual({
      totalRecords: 0,
      presentCount: 0,
      lateCount: 0,
      incompleteCount: 0,
      distinctUsers: 0,
      totalWorkedMinutes: 0,
    });
  });

  it('counts each status and sums worked minutes', () => {
    const totals = new ExportTotals();
    totals.add(reportRecord({ userId: 'u1', workedMinutes: 480 }));
    totals.add(reportRecord({ userId: 'u2', status: AttendanceStatus.LATE, workedMinutes: 420 }));
    totals.add(
      reportRecord({
        userId: 'u1',
        status: AttendanceStatus.INCOMPLETE,
        // An open shift contributes zero minutes, not NaN.
        workedMinutes: null,
      }),
    );

    expect(totals.toSummary()).toEqual({
      totalRecords: 3,
      presentCount: 1,
      lateCount: 1,
      incompleteCount: 1,
      distinctUsers: 2,
      totalWorkedMinutes: 900,
    });
    expect(totals.rowCount).toBe(3);
  });
});

describe('summarize', () => {
  it('folds the per-status aggregate the report query returns', () => {
    expect(
      summarize(
        [
          { status: AttendanceStatus.PRESENT, _count: { _all: 4 }, _sum: { workedMinutes: 1920 } },
          { status: AttendanceStatus.LATE, _count: { _all: 2 }, _sum: { workedMinutes: 800 } },
          {
            status: AttendanceStatus.INCOMPLETE,
            _count: { _all: 1 },
            _sum: { workedMinutes: null },
          },
        ],
        3,
      ),
    ).toEqual({
      totalRecords: 7,
      presentCount: 4,
      lateCount: 2,
      incompleteCount: 1,
      distinctUsers: 3,
      totalWorkedMinutes: 2720,
    });
  });

  it('returns zeros for an empty range rather than undefined counts', () => {
    expect(summarize([], 0)).toEqual({
      totalRecords: 0,
      presentCount: 0,
      lateCount: 0,
      incompleteCount: 0,
      distinctUsers: 0,
      totalWorkedMinutes: 0,
    });
  });
});
