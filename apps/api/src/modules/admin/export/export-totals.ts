import { AttendanceStatus, type ReportSummary } from '@wasel/contracts';
import type { ReportRecord } from '../admin.mapper.js';

/**
 * Running totals for an export.
 *
 * Accumulated *while streaming* rather than fetched with a second aggregate
 * query, for two reasons: it saves a full second pass over the range, and it
 * guarantees the summary describes exactly the rows the file contains — a
 * separate query run a moment later can legitimately return a different count
 * while people are still punching in.
 *
 * The only unbounded structure is the distinct-user set, and it is bounded by
 * the organization's headcount, not by the size of the range.
 */
export class ExportTotals {
  private readonly userIds = new Set<string>();
  private records = 0;
  private present = 0;
  private late = 0;
  private incomplete = 0;
  private workedMinutes = 0;

  add(record: ReportRecord): void {
    this.records += 1;
    this.userIds.add(record.userId);
    this.workedMinutes += record.workedMinutes ?? 0;

    if (record.status === AttendanceStatus.PRESENT) this.present += 1;
    else if (record.status === AttendanceStatus.LATE) this.late += 1;
    else if (record.status === AttendanceStatus.INCOMPLETE) this.incomplete += 1;
  }

  get rowCount(): number {
    return this.records;
  }

  toSummary(): ReportSummary {
    return {
      totalRecords: this.records,
      presentCount: this.present,
      lateCount: this.late,
      incompleteCount: this.incomplete,
      distinctUsers: this.userIds.size,
      totalWorkedMinutes: this.workedMinutes,
    };
  }
}
