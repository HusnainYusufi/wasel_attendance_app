import { describe, expect, it } from 'vitest';
import { distanceInMeters, findNearestSite, formatDistance, type GeofenceSite } from '../geo.js';

const site = (over: Partial<GeofenceSite> = {}): GeofenceSite => ({
  id: 'site-1',
  name: 'Head Office',
  latitude: 24.7136,
  longitude: 46.6753,
  radiusMeters: 150,
  ...over,
});

describe('distanceInMeters', () => {
  it('is zero for identical points', () => {
    expect(
      distanceInMeters({ latitude: 24.7, longitude: 46.6 }, { latitude: 24.7, longitude: 46.6 }),
    ).toBe(0);
  });

  it('matches a known one-degree-of-latitude distance', () => {
    // One degree of latitude is ~111.19 km everywhere on a sphere.
    const d = distanceInMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(d / 1000).toBeCloseTo(111.19, 1);
  });

  it('matches a known city pair (Riyadh → Jeddah ≈ 845 km)', () => {
    const d = distanceInMeters(
      { latitude: 24.7136, longitude: 46.6753 },
      { latitude: 21.4858, longitude: 39.1925 },
    );
    expect(d / 1000).toBeGreaterThan(840);
    expect(d / 1000).toBeLessThan(860);
  });

  it('is symmetric', () => {
    const a = { latitude: 24.7136, longitude: 46.6753 };
    const b = { latitude: 25.2854, longitude: 51.531 };
    expect(distanceInMeters(a, b)).toBeCloseTo(distanceInMeters(b, a), 6);
  });

  it('does not produce NaN for antipodal points', () => {
    // The naive spherical-law-of-cosines form returns NaN here through
    // floating-point drift pushing the argument of acos past 1.
    const d = distanceInMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(20_000_000);
  });

  it('resolves sub-metre differences without precision collapse', () => {
    // ~1.1 m apart. This is the range a geofence actually operates in.
    const d = distanceInMeters(
      { latitude: 24.7136, longitude: 46.6753 },
      { latitude: 24.71361, longitude: 46.6753 },
    );
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(2);
  });

  it('handles the poles and the antimeridian without throwing', () => {
    expect(
      Number.isFinite(
        distanceInMeters({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 }),
      ),
    ).toBe(true);
    const acrossDateline = distanceInMeters(
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    );
    // 0.2° of longitude at the equator ≈ 22 km — crossing the antimeridian must
    // not be computed as if it were 359.8° the long way round.
    expect(acrossDateline / 1000).toBeCloseTo(22.2, 0);
  });
});

describe('findNearestSite', () => {
  it('returns null when there are no sites', () => {
    expect(findNearestSite({ latitude: 0, longitude: 0 }, [])).toBeNull();
  });

  it('picks the closest of several sites', () => {
    const near = site({ id: 'near' });
    const far = site({ id: 'far', latitude: 25.5 });
    const match = findNearestSite({ latitude: 24.7137, longitude: 46.6754 }, [far, near]);
    expect(match?.site.id).toBe('near');
    expect(match?.withinFence).toBe(true);
  });

  it('is independent of input ordering', () => {
    const a = site({ id: 'a' });
    const b = site({ id: 'b', latitude: 25.5 });
    const point = { latitude: 24.7137, longitude: 46.6754 };
    expect(findNearestSite(point, [a, b])?.site.id).toBe(findNearestSite(point, [b, a])?.site.id);
  });

  it('still reports the nearest site when the user is out of range', () => {
    // The user needs to know how far away they are, not just that they failed.
    const match = findNearestSite({ latitude: 25.9, longitude: 46.6753 }, [site()]);
    expect(match).not.toBeNull();
    expect(match?.withinFence).toBe(false);
    expect(match?.distanceM).toBeGreaterThan(150);
  });

  it('treats the fence as inclusive at exactly the radius', () => {
    // Someone standing precisely on the boundary is inside it. Deriving the
    // radius from the measured distance tests the `<=` rather than a hand-picked
    // constant that only happens to land on the right side of it.
    const point = { latitude: 25.7136, longitude: 46.6753 };
    const exact = Math.ceil(distanceInMeters(point, site()));
    const match = findNearestSite(point, [site({ radiusMeters: exact })]);
    expect(match?.withinFence).toBe(true);

    const justInside = findNearestSite(point, [site({ radiusMeters: exact - 1 })]);
    expect(justInside?.withinFence).toBe(false);
  });
});

describe('formatDistance', () => {
  it.each([
    [0, '0 m'],
    [45.4, '45 m'],
    [999, '999 m'],
    [1000, '1.0 km'],
    [1234, '1.2 km'],
    [15_000, '15 km'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatDistance(input)).toBe(expected);
  });

  it('degrades gracefully on a non-finite value', () => {
    expect(formatDistance(Number.NaN)).toBe('—');
  });
});
