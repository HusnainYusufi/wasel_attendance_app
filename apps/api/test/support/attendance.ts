import type { Site } from '@prisma/client';
import { EARTH_RADIUS_M, SITE_RADIUS_DEFAULT_M, type Coordinates } from '@wasel/contracts';
import type { TestApp } from './create-test-app.js';

/**
 * Fixtures for the attendance suites.
 *
 * Kept out of `support/index.js` so that two agents adding helpers at the same
 * time do not collide on one barrel file; import it directly.
 */

/** Wasel's head office, and the origin every geofence fixture is measured from. */
export const HQ: Coordinates = { latitude: 24.7136, longitude: 46.6753 };

export interface CreateSiteOptions {
  name?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  isActive?: boolean;
  deletedAt?: Date | null;
}

export function createSite(
  ctx: TestApp,
  organizationId: string,
  options: CreateSiteOptions = {},
): Promise<Site> {
  return ctx.prisma.site.create({
    data: {
      organizationId,
      name: options.name ?? 'Head Office',
      latitude: options.latitude ?? HQ.latitude,
      longitude: options.longitude ?? HQ.longitude,
      radiusMeters: options.radiusMeters ?? SITE_RADIUS_DEFAULT_M,
      isActive: options.isActive ?? true,
      deletedAt: options.deletedAt ?? null,
    },
  });
}

const toRadians = (deg: number): number => (deg * Math.PI) / 180;
const toDegrees = (rad: number): number => (rad * 180) / Math.PI;

/**
 * A point exactly `meters` from `origin` along `bearingDeg`.
 *
 * The inverse of the contract's `distanceInMeters`, on the same sphere and with
 * the same radius, so `distanceInMeters(origin, pointAtDistance(origin, d))`
 * returns `d` to within floating-point noise. That is what lets a test assert on
 * a fence boundary in metres instead of guessing at decimal degrees — a naive
 * `latitude + 0.001` offset means a different distance at every latitude.
 */
export function pointAtDistance(origin: Coordinates, meters: number, bearingDeg = 0): Coordinates {
  const angular = meters / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDeg);
  const lat = toRadians(origin.latitude);
  const lon = toRadians(origin.longitude);

  const destLat = Math.asin(
    Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing),
  );
  const destLon =
    lon +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat),
      Math.cos(angular) - Math.sin(lat) * Math.sin(destLat),
    );

  return { latitude: toDegrees(destLat), longitude: toDegrees(destLon) };
}

/** A punch payload at `point`, with a fix good enough to pass the default policy. */
export function punchAt(point: Coordinates, accuracy = 8): Record<string, unknown> {
  return { latitude: point.latitude, longitude: point.longitude, accuracy };
}
