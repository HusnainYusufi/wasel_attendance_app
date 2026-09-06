/**
 * Conditional-request handling for the avatar endpoint.
 *
 * Every other response this API produces is `no-store`, and correctly so: they
 * are per-tenant JSON that no cache may keep. An avatar is different in kind —
 * it is a small immutable blob that a screen redraws on every navigation — so
 * refetching it from Postgres each time is pure waste.
 *
 * The compromise encoded here is `private, no-cache`: a client *may* keep the
 * bytes, but must revalidate before every reuse. That is what makes a replaced
 * avatar impossible to serve stale while still turning the common case into a
 * bodyless 304. `private` keeps it out of shared caches, which matters because
 * the resource is authenticated.
 *
 * Pure functions over plain values, so the freshness decision is unit-testable
 * without an HTTP server.
 */

/** `Cache-Control` for an avatar response, including the 304. */
export const AVATAR_CACHE_CONTROL = 'private, no-cache';

/**
 * A strong validator for a stored avatar.
 *
 * `updatedAt` alone would be a millisecond timestamp, and `UserAvatar.updatedAt`
 * is `Timestamptz(3)` — so two replacements inside the same millisecond would
 * produce one validator for two different images. `byteSize` is mixed in because
 * it is free and changes for essentially any real replacement; a caller who
 * managed to upload two distinct images of identical length within the same
 * millisecond would get one stale revalidation, which is bounded by the fact
 * that nothing may cache the response for longer than one use.
 */
export function avatarEtag(updatedAt: Date, byteSize: number): string {
  const stamp = updatedAt.getTime().toString(36);
  return `"${stamp}-${byteSize.toString(36)}"`;
}

/** An HTTP-date, which has one-second resolution. */
export function httpDate(value: Date): string {
  return value.toUTCString();
}

/** `Last-Modified` must not claim sub-second precision it cannot express. */
export function truncateToSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

/**
 * Does an `If-None-Match` header cover `etag`?
 *
 * RFC 9110 §13.1.2 specifies the *weak* comparison for `If-None-Match`, so the
 * `W/` prefix is stripped from both sides. `*` matches any existing
 * representation, which is how a client asks "give me a 304 if this exists at
 * all".
 */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const candidates = header.split(',').map((entry) => entry.trim());
  if (candidates.includes('*')) return true;

  const normalise = (value: string): string =>
    value.startsWith('W/') ? value.slice(2).trim() : value;
  const wanted = normalise(etag);
  return candidates.some((candidate) => normalise(candidate) === wanted);
}

/**
 * Does an `If-Modified-Since` header prove the client already has this version?
 *
 * Only consulted when there is no `If-None-Match`: the entity tag is the more
 * precise validator and RFC 9110 §13.1.3 says it wins outright. A malformed date
 * is ignored rather than rejected — the fallback is simply to send the body.
 */
export function ifModifiedSinceSatisfied(header: string | undefined, lastModified: Date): boolean {
  if (!header) return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return truncateToSecond(lastModified).getTime() <= since;
}

export interface ConditionalHeaders {
  ifNoneMatch?: string | undefined;
  ifModifiedSince?: string | undefined;
}

/**
 * May this request be answered `304 Not Modified`?
 *
 * The entity tag takes precedence and the date is not consulted at all when one
 * was sent — a client that offers both and whose tag does *not* match is telling
 * us it holds a different version, and honouring its stale date would serve it
 * a 304 for an image it does not have.
 */
export function isNotModified(
  headers: ConditionalHeaders,
  etag: string,
  lastModified: Date,
): boolean {
  if (headers.ifNoneMatch) return ifNoneMatchSatisfied(headers.ifNoneMatch, etag);
  return ifModifiedSinceSatisfied(headers.ifModifiedSince, lastModified);
}
