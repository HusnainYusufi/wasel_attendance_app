import type { Coordinates } from './common.js';

/**
 * Mean Earth radius (IUGG), metres. Haversine on a sphere is accurate to ~0.5%
 * versus the WGS-84 ellipsoid — around 0.5 m over a 100 m geofence, far inside
 * consumer GPS noise, so the extra cost of Vincenty buys nothing here.
 */
export const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres.
 *
 * Uses the haversine form rather than the spherical law of cosines because the
 * latter loses catastrophic precision at small distances — exactly the range a
 * geofence operates in.
 */
export function distanceInMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;

  // Clamp guards against h drifting a hair above 1 through floating-point error,
  // which would make Math.sqrt produce NaN for antipodal points.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

export interface GeofenceSite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface GeofenceMatch {
  site: GeofenceSite;
  distanceM: number;
  withinFence: boolean;
}

/**
 * Nearest site to `point`, with its distance.
 *
 * Returns the nearest site even when it is out of range, so the caller can tell
 * the user *how far* they are from where they should be rather than an unhelpful
 * bare "out of range". Returns null only when there are no sites at all.
 */
export function findNearestSite(
  point: Coordinates,
  sites: readonly GeofenceSite[],
): GeofenceMatch | null {
  let best: GeofenceMatch | null = null;

  for (const site of sites) {
    const distanceM = distanceInMeters(point, site);
    if (best === null || distanceM < best.distanceM) {
      best = { site, distanceM, withinFence: distanceM <= site.radiusMeters };
    }
  }

  return best;
}

/** Human-friendly distance, e.g. "45 m" or "1.2 km". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}
