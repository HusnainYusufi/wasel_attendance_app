/**
 * Timezone-aware formatting.
 *
 * Every timestamp the API returns is a UTC instant, and every one of them must
 * be rendered in the *organization's* IANA timezone — not the handset's. A user
 * in Dubai looking at a Riyadh organization must see Riyadh wall-clock time, or
 * "you checked in at 09:05" is simply wrong for them.
 *
 * `Intl.DateTimeFormat` does the conversion; formatters are memoised because
 * constructing one is comparatively expensive and the live clock rebuilds its
 * output every second.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;

  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
  } catch {
    // An organization configured with a timezone this runtime's tz database has
    // never heard of must not blank the whole screen; fall back to the host zone.
    created = new Intl.DateTimeFormat('en-GB', options);
  }
  formatterCache.set(key, created);
  return created;
}

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Wall-clock time of day, e.g. `09:05`. Always 24-hour: unambiguous, and it
 *  keeps a fixed character count so tabular figures do not reflow. */
export function formatTime(value: string | number | Date, timeZone: string): string {
  const date = toDate(value);
  if (!date) return '—';
  return formatter(timeZone, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/** `09:05:33` — for the live clock only, where seconds carry the "it's alive" signal. */
export function formatTimeWithSeconds(value: string | number | Date, timeZone: string): string {
  const date = toDate(value);
  if (!date) return '—';
  return formatter(timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/** `Saturday, 6 September 2026`. */
export function formatFullDate(value: string | number | Date, timeZone: string): string {
  const date = toDate(value);
  if (!date) return '—';
  return formatter(timeZone, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/**
 * A `YYYY-MM-DD` work date is a *calendar date*, not an instant: parsing it and
 * then re-projecting it through a timezone would shift it by a day for anyone
 * west of UTC. It is formatted as UTC noon, which no timezone offset can move
 * across a date boundary.
 */
function workDateAsInstant(workDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(workDate);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

/** `Sat 6 Sep` from a `YYYY-MM-DD` work date. */
export function formatWorkDate(workDate: string): string {
  const date = workDateAsInstant(workDate);
  if (!date) return workDate;
  return formatter('UTC', { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}

/** `6` — the day number, for a history row's leading date block. */
export function workDateDayNumber(workDate: string): string {
  const date = workDateAsInstant(workDate);
  if (!date) return '—';
  return formatter('UTC', { day: 'numeric' }).format(date);
}

/** `Sat` — the weekday, for a history row's leading date block. */
export function workDateWeekday(workDate: string): string {
  const date = workDateAsInstant(workDate);
  if (!date) return '';
  return formatter('UTC', { weekday: 'short' }).format(date);
}

/** `September 2026` — a history group heading. */
export function formatMonthLabel(workDate: string): string {
  const date = workDateAsInstant(workDate);
  if (!date) return workDate;
  return formatter('UTC', { month: 'long', year: 'numeric' }).format(date);
}

/** `2026-09` — the grouping key behind {@link formatMonthLabel}. */
export function monthKey(workDate: string): string {
  return workDate.slice(0, 7);
}

/**
 * `7h 32m`, `45m`, `0m`. Durations are read at a glance, so the unit letters stay
 * attached to their numbers and a zero hour count is dropped entirely.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** The organization-local calendar date for an instant, as `YYYY-MM-DD`. */
export function isoDateIn(timeZone: string, value: Date = new Date()): string {
  const parts = formatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Adds `days` to a `YYYY-MM-DD` date. Calendar-safe: no DST drift, no month overflow. */
export function addDays(isoDate: string, days: number): string {
  const date = workDateAsInstant(isoDate);
  if (!date) return isoDate;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First day of the month containing `isoDate`. */
export function startOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

/** Last day of the month containing `isoDate`. */
export function endOfMonth(isoDate: string): string {
  const date = workDateAsInstant(isoDate);
  if (!date) return isoDate;
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
}

/** The month before the one containing `isoDate`, as an inclusive range. */
export function previousMonthRange(isoDate: string): { from: string; to: string } {
  const date = workDateAsInstant(isoDate);
  if (!date) return { from: isoDate, to: isoDate };
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  const from = date.toISOString().slice(0, 10);
  return { from, to: endOfMonth(from) };
}

/**
 * An inclusive range, written the way a person would say it: `1 – 30 September
 * 2026`, collapsing the parts the two ends share. Two bare ISO strings are
 * precise but read as machine output on a summary card.
 */
export function formatDateRange(from: string, to: string): string {
  const start = workDateAsInstant(from);
  const end = workDateAsInstant(to);
  if (!start || !end) return `${from} to ${to}`;

  const day = (date: Date) => formatter('UTC', { day: 'numeric' }).format(date);
  const dayMonth = (date: Date) => formatter('UTC', { day: 'numeric', month: 'long' }).format(date);
  const full = (date: Date) =>
    formatter('UTC', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);

  if (from === to) return full(start);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = sameYear && from.slice(0, 7) === to.slice(0, 7);

  if (sameMonth) return `${day(start)} – ${full(end)}`;
  if (sameYear) return `${dayMonth(start)} – ${full(end)}`;
  return `${full(start)} – ${full(end)}`;
}
