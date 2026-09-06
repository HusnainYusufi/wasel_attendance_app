import { z } from 'zod';
import {
  ACCURACY_CEILING_M,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './constants.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const uuidSchema = z.uuid({ message: 'Must be a valid UUID' });

/**
 * Emails are normalised (trimmed + lowercased) at the schema boundary so that
 * uniqueness checks, lookups and logins all agree on one canonical form.
 * Doing this anywhere later means `Ali@x.com` and `ali@x.com` become two accounts.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }))
  .pipe(z.string().max(255, 'Email must be at most 255 characters'));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => /[a-zA-Z]/.test(v), { message: 'Password must contain a letter' })
  .refine((v) => /[0-9]/.test(v), { message: 'Password must contain a number' });

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(120, 'Name must be at most 120 characters');

export const employeeCodeSchema = z
  .string()
  .trim()
  .max(32, 'Employee code must be at most 32 characters')
  .regex(
    /^[A-Za-z0-9._-]*$/,
    'Employee code may contain only letters, numbers, dot, dash, underscore',
  );

/** IANA timezone identifier, validated against the host's own tz database. */
export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA timezone, e.g. Asia/Riyadh' },
  );

/** Wall-clock time of day, 24h "HH:mm". */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Must be a 24-hour time in HH:mm form');

/** Calendar date, "YYYY-MM-DD". */
export const isoDateSchema = z.iso.date();

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------

export const latitudeSchema = z
  .number()
  .finite('Latitude must be a finite number')
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90');

export const longitudeSchema = z
  .number()
  .finite('Longitude must be a finite number')
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180');

/**
 * Horizontal accuracy radius in metres as reported by the device.
 * Zero is rejected: a real GNSS fix always carries a non-zero error estimate, so
 * `0` signals a spoofed or synthesised location payload.
 */
export const accuracySchema = z
  .number()
  .finite('Accuracy must be a finite number')
  .positive('Accuracy must be greater than zero')
  .max(ACCURACY_CEILING_M, `Accuracy radius must be at most ${ACCURACY_CEILING_M} metres`);

export const coordinatesSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});
export type Coordinates = z.infer<typeof coordinatesSchema>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

export function buildPageMeta(page: number, pageSize: number, total: number): PageMeta {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && total > 0,
  };
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

/**
 * Inclusive calendar-date range. Both bounds are local dates in the
 * organization's timezone, never UTC instants.
 */
export const dateRangeSchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((v) => v.from <= v.to, {
    message: '`from` must be on or before `to`',
    path: ['from'],
  });
export type DateRange = z.infer<typeof dateRangeSchema>;

/** Whole days spanned by an inclusive YYYY-MM-DD range. Calendar-safe (no DST drift). */
export function inclusiveDayCount(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.floor((b - a) / 86_400_000) + 1;
}
