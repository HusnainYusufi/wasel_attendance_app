/**
 * A fallback list for runtimes without `Intl.supportedValuesOf`, which is the
 * only way to enumerate the tz database from the browser. Deliberately short and
 * regional rather than a hand-maintained copy of the IANA list, which would rot.
 */
const FALLBACK_ZONES = [
  'UTC',
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Qatar',
  'Asia/Kuwait',
  'Asia/Bahrain',
  'Asia/Muscat',
  'Asia/Amman',
  'Asia/Beirut',
  'Asia/Baghdad',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Istanbul',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
] as const;

/**
 * Every IANA zone this runtime knows, with `current` guaranteed to be present.
 *
 * The guarantee matters: an organization configured with a zone the browser's tz
 * database has since retired would otherwise find its own setting missing from
 * the picker, and saving the form would silently move the whole tenant to
 * whichever zone happened to be selected first.
 */
export function supportedTimeZones(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };

  let zones: string[];
  try {
    const listed = intl.supportedValuesOf?.('timeZone');
    zones = Array.isArray(listed) && listed.length > 0 ? [...listed] : [...FALLBACK_ZONES];
  } catch {
    zones = [...FALLBACK_ZONES];
  }

  if (current && !zones.includes(current)) zones.unshift(current);
  return zones;
}

/** `Asia/Riyadh` → `Asia / Riyadh` — readable in a picker without losing the id. */
export function formatZoneLabel(zone: string): string {
  return zone.replace(/_/g, ' ').replace('/', ' / ');
}
