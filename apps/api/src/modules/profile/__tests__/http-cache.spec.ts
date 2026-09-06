import { describe, expect, it } from 'vitest';
import {
  AVATAR_CACHE_CONTROL,
  avatarEtag,
  httpDate,
  ifModifiedSinceSatisfied,
  ifNoneMatchSatisfied,
  isNotModified,
  truncateToSecond,
} from '../http-cache.js';

const AT = new Date('2026-09-07T10:15:30.250Z');

describe('avatarEtag', () => {
  it('is a quoted strong validator', () => {
    expect(avatarEtag(AT, 1024)).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
  });

  it('changes when the image is replaced', () => {
    const before = avatarEtag(AT, 1024);
    const after = avatarEtag(new Date(AT.getTime() + 1), 1024);
    expect(after).not.toBe(before);
  });

  it('changes when only the size changes', () => {
    // The size is mixed in precisely so that two replacements inside one
    // millisecond — the resolution of `Timestamptz(3)` — do not collide.
    expect(avatarEtag(AT, 1024)).not.toBe(avatarEtag(AT, 2048));
  });

  it('is stable for one stored version', () => {
    expect(avatarEtag(AT, 1024)).toBe(avatarEtag(new Date(AT.getTime()), 1024));
  });
});

describe('truncateToSecond', () => {
  it('drops the milliseconds an HTTP-date cannot express', () => {
    expect(truncateToSecond(AT).toISOString()).toBe('2026-09-07T10:15:30.000Z');
  });
});

describe('httpDate', () => {
  it('renders an RFC 9110 HTTP-date', () => {
    expect(httpDate(AT)).toBe('Mon, 07 Sep 2026 10:15:30 GMT');
  });
});

describe('ifNoneMatchSatisfied', () => {
  const etag = avatarEtag(AT, 1024);

  it('matches the same tag', () => {
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
  });

  it('matches weakly, as the specification requires for If-None-Match', () => {
    // RFC 9110 §13.1.2 mandates the weak comparison here, so a proxy that added
    // a W/ prefix must not force a full re-download.
    expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfied(etag, `W/${etag}`)).toBe(true);
  });

  it('matches one entry out of a list', () => {
    expect(ifNoneMatchSatisfied(`"other", ${etag}, "another"`, etag)).toBe(true);
  });

  it('matches the wildcard', () => {
    expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
  });

  it('does not match a different version', () => {
    expect(ifNoneMatchSatisfied('"stale"', etag)).toBe(false);
  });

  it('is false when the header is absent or empty', () => {
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfied('', etag)).toBe(false);
  });
});

describe('ifModifiedSinceSatisfied', () => {
  it('is satisfied by a date at or after the stored second', () => {
    expect(ifModifiedSinceSatisfied('Mon, 07 Sep 2026 10:15:30 GMT', AT)).toBe(true);
    expect(ifModifiedSinceSatisfied('Mon, 07 Sep 2026 11:00:00 GMT', AT)).toBe(true);
  });

  it('is not satisfied by an earlier date', () => {
    expect(ifModifiedSinceSatisfied('Mon, 07 Sep 2026 10:15:29 GMT', AT)).toBe(false);
  });

  it('compares at second resolution, so a sub-second remainder is not "modified"', () => {
    // `updatedAt` carries milliseconds the Last-Modified header cannot; without
    // truncation the server would answer 200 forever to a client echoing back
    // the exact date it was given.
    expect(ifModifiedSinceSatisfied(httpDate(AT), AT)).toBe(true);
  });

  it('ignores a malformed date rather than refusing the request', () => {
    expect(ifModifiedSinceSatisfied('whenever', AT)).toBe(false);
    expect(ifModifiedSinceSatisfied(undefined, AT)).toBe(false);
  });
});

describe('isNotModified', () => {
  const etag = avatarEtag(AT, 1024);

  it('answers from the entity tag when one is offered', () => {
    expect(isNotModified({ ifNoneMatch: etag }, etag, AT)).toBe(true);
  });

  it('lets the entity tag override a stale date', () => {
    // The client is telling us which version it holds. Honouring its date while
    // its tag disagrees would send a 304 for an image it does not have.
    const stale = isNotModified(
      { ifNoneMatch: '"old"', ifModifiedSince: 'Mon, 07 Sep 2026 23:00:00 GMT' },
      etag,
      AT,
    );
    expect(stale).toBe(false);
  });

  it('falls back to the date when no entity tag is offered', () => {
    expect(isNotModified({ ifModifiedSince: httpDate(AT) }, etag, AT)).toBe(true);
  });

  it('is false with no conditional headers at all', () => {
    expect(isNotModified({}, etag, AT)).toBe(false);
  });
});

describe('AVATAR_CACHE_CONTROL', () => {
  it('keeps the image out of shared caches and revalidates before every reuse', () => {
    // The resource is authenticated and per-user, so `private`; and a replaced
    // avatar must never be served from a client's store without asking, so
    // `no-cache` rather than a max-age.
    expect(AVATAR_CACHE_CONTROL).toBe('private, no-cache');
  });
});
