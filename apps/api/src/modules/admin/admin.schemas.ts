import { reportRowSchema, reportSummarySchema, siteSchema, userSchema } from '@wasel/contracts';
import { z } from 'zod';

/**
 * Response envelopes, composed from contract schemas.
 *
 * `@wasel/contracts` defines `Paginated<T>` and `PageMeta` as TypeScript types
 * but not as Zod schemas — they are generic, and a generic has no single runtime
 * shape to register. These compositions exist purely so the OpenAPI document
 * describes what the routes actually return; the element schemas are the
 * contract's own, so this is a composition rather than the parallel DTO that
 * `docs/CONVENTIONS.md` §1 forbids.
 */
export const pageMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
});

const paginated = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), meta: pageMetaSchema });

export const paginatedUsersSchema = paginated(userSchema);
export const paginatedSitesSchema = paginated(siteSchema);

/** The report route returns the page *and* totals for the whole filtered range. */
export const attendanceReportSchema = paginated(reportRowSchema).extend({
  summary: reportSummarySchema,
});
export type AttendanceReport = z.infer<typeof attendanceReportSchema>;
