/**
 * `AuditLog.action` values written by the admin module.
 *
 * Dotted, namespaced and stable, exactly like the auth module's set: they are
 * what an auditor filters on, so they must survive a method rename.
 */
export const AdminAuditAction = {
  USER_CREATED: 'admin.user.created',
  USER_UPDATED: 'admin.user.updated',
  USER_DELETED: 'admin.user.deleted',
  USER_PASSWORD_RESET: 'admin.user.password_reset',
  /**
   * A password reset performed on *another administrator*.
   *
   * Separate from {@link AdminAuditAction.USER_PASSWORD_RESET} because it is the
   * one reset that hands an administrator someone else's identity: the target's
   * sessions die and the caller now knows their credentials. Filtering that out
   * of the ordinary "I reset an employee's password" traffic is the difference
   * between an alert and an archaeology exercise.
   */
  ADMIN_PASSWORD_RESET: 'admin.user.admin_password_reset',
  SITE_CREATED: 'admin.site.created',
  SITE_UPDATED: 'admin.site.updated',
  SITE_DELETED: 'admin.site.deleted',
  ORGANIZATION_UPDATED: 'admin.organization.updated',
  /**
   * The tenant's IANA timezone moved.
   *
   * Written *in addition to* {@link AdminAuditAction.ORGANIZATION_UPDATED}, which
   * already records the same pair in its metadata. The two rows answer different
   * questions and only one of them is answerable by a query. `ORGANIZATION_UPDATED`
   * says "this request changed these settings"; this row is the tenant's timezone
   * *timeline*, and the export reads it on every download to decide whether the
   * range it is rendering predates the zone it is rendering in. Doing that against
   * the generic row would mean a JSON-path predicate over every settings edit the
   * tenant has ever made, to find the handful that touched the one setting that
   * changes what a stored `workDate` means.
   */
  ORGANIZATION_TIMEZONE_CHANGED: 'admin.organization.timezone_changed',
  /** Intent, written before the first response byte. */
  REPORT_EXPORT_STARTED: 'admin.report.export_started',
  REPORT_EXPORTED: 'admin.report.exported',
  /** The download did not complete — a cancelled client, or a rendering failure. */
  REPORT_EXPORT_FAILED: 'admin.report.export_failed',
} as const;
export type AdminAuditAction = (typeof AdminAuditAction)[keyof typeof AdminAuditAction];

/** `AuditLog.entityType` values. Prisma model names, so a row can be resolved. */
export const AdminAuditEntity = {
  USER: 'User',
  SITE: 'Site',
  ORGANIZATION: 'Organization',
  REPORT: 'AttendanceReport',
} as const;
export type AdminAuditEntity = (typeof AdminAuditEntity)[keyof typeof AdminAuditEntity];

/**
 * Rows pulled per round trip while streaming an export.
 *
 * The export is bounded by `EXPORT_MAX_RANGE_DAYS` (366) in *days*, not in rows:
 * a 400-person organization over a year is ~100k records, which is far too many
 * to hold in memory as objects *and* as a rendered workbook. Keyset batches of
 * this size keep the resident set flat and independent of the range, at the cost
 * of one query per batch.
 */
export const EXPORT_BATCH_SIZE = 500;

/**
 * The most data rows an XLSX export may contain.
 *
 * This is not a policy number, it is the file format's own ceiling: a worksheet
 * holds 1,048,576 rows, one of which this sheet spends on its header. A workbook
 * built past that point is not a large download, it is a corrupt one — Excel
 * refuses to open it — so the request is refused *before* the first byte, where
 * there is still an error envelope to refuse it with.
 *
 * Memory is bounded by backpressure rather than by this cap (see
 * `export/export-sink.ts`), which is why CSV needs no equivalent: it has no
 * structural row limit to violate.
 */
export const XLSX_MAX_SHEET_ROWS = 1_048_576;
export const EXPORT_MAX_XLSX_ROWS = XLSX_MAX_SHEET_ROWS - 1;
