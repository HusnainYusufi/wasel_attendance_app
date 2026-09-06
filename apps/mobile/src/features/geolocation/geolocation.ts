import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { ACCURACY_CEILING_M } from '@wasel/contracts';

/**
 * One position fix, reduced to exactly what a punch needs.
 *
 * `accuracy` is the horizontal error radius in metres. It is not decoration: the
 * server refuses a fix whose error radius exceeds the organization's ceiling,
 * because "at the office ± 3 km" is compatible with being anywhere in the city.
 */
export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  /** Epoch milliseconds, from the device — used only to age the fix locally. */
  timestamp: number;
}

/**
 * Why a fix could not be obtained. Each kind maps to a *different recovery*,
 * which is the whole reason they are distinguished: telling someone who turned
 * location services off to "move outside" is a dead end.
 */
export type GeoErrorKind =
  | 'unsupported'
  | 'insecure-context'
  | 'permission-denied'
  | 'permission-blocked'
  | 'unavailable'
  | 'timeout'
  | 'accuracy-unknown'
  | 'accuracy-absurd';

export class GeolocationFailure extends Error {
  readonly kind: GeoErrorKind;

  constructor(kind: GeoErrorKind, message: string) {
    super(message);
    this.name = 'GeolocationFailure';
    this.kind = kind;
  }
}

export interface LocateOptions {
  /** High accuracy costs battery and time; a geofence needs it regardless. */
  timeoutMs?: number;
  /** Accept a cached fix younger than this. `0` forces a fresh one. */
  maximumAgeMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Browser `GeolocationPositionError` codes, which the constants are not
 *  guaranteed to be present for in every runtime. */
const POSITION_ERROR = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as const;

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function hasBrowserGeolocation(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

interface RawCoordinates {
  latitude: number;
  longitude: number;
  accuracy: number | null | undefined;
}

/**
 * Turns raw coordinates into a `GeoFix`, rejecting the two accuracy values the
 * API contract will not accept.
 *
 * A missing or zero accuracy is not "perfect": the contract treats it as a
 * synthesised payload and rejects it, so the client must say so here rather than
 * let the user tap CHECK IN into a guaranteed 400.
 *
 * The fields are read one by one on purpose. `GeolocationCoordinates` exposes
 * everything through prototype getters, so `{ ...position.coords }` yields an
 * empty object in Chrome and Safari — a spread here silently turns every real
 * fix into "your device returned an unusable position".
 */
function toFix(coords: RawCoordinates, timestamp: number | undefined): GeoFix {
  const latitude = coords.latitude;
  const longitude = coords.longitude;
  const accuracy = coords.accuracy;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new GeolocationFailure('unavailable', 'Your device returned an unusable position.');
  }
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy <= 0) {
    throw new GeolocationFailure(
      'accuracy-unknown',
      'Your device reported a position but no accuracy for it, so it cannot be trusted for a geofenced punch.',
    );
  }
  if (accuracy > ACCURACY_CEILING_M) {
    throw new GeolocationFailure(
      'accuracy-absurd',
      `Your position is only accurate to ${Math.round(accuracy)} m, which is too vague to place you at a site.`,
    );
  }

  return { latitude, longitude, accuracy, timestamp: timestamp ?? Date.now() };
}

/**
 * Whether the browser has *permanently* blocked this origin, as opposed to the
 * user dismissing a single prompt. The two look identical in the error callback
 * but need opposite advice — one is "tap allow", the other is "unblock the site
 * in your browser settings".
 */
async function isBrowserPermissionBlocked(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions) return false;
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state === 'denied';
  } catch {
    // Firefox historically rejected this query for geolocation. Unknown ≠ blocked.
    return false;
  }
}

async function locateInBrowser(options: LocateOptions): Promise<GeoFix> {
  if (!hasBrowserGeolocation()) {
    throw new GeolocationFailure(
      'unsupported',
      'This browser cannot report a location, so a geofenced punch is not possible here.',
    );
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new GeolocationFailure(
      'insecure-context',
      'Location is only available over a secure (https) connection.',
    );
  }

  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maximumAge: options.maximumAgeMs ?? 0,
    });
  }).catch(async (error: unknown) => {
    const code = (error as GeolocationPositionError | undefined)?.code;

    if (code === POSITION_ERROR.PERMISSION_DENIED) {
      const blocked = await isBrowserPermissionBlocked();
      throw new GeolocationFailure(
        blocked ? 'permission-blocked' : 'permission-denied',
        blocked
          ? 'Location is blocked for this site in your browser settings.'
          : 'Wasel needs your location to confirm you are at your site.',
      );
    }
    if (code === POSITION_ERROR.TIMEOUT) {
      throw new GeolocationFailure(
        'timeout',
        'Finding your location took too long. GPS is usually much faster outdoors.',
      );
    }
    throw new GeolocationFailure(
      'unavailable',
      'Your device could not get a location fix. Check that location services are on.',
    );
  });

  return toFix(position.coords, position.timestamp);
}

async function locateOnDevice(options: LocateOptions): Promise<GeoFix> {
  let permission: string;
  try {
    permission = (await Geolocation.checkPermissions()).location;
  } catch {
    // `checkPermissions` throws when system location services are switched off
    // entirely — a different fix from granting the app permission.
    throw new GeolocationFailure(
      'unavailable',
      'Location services are turned off on this device. Switch them on and try again.',
    );
  }

  if (permission === 'prompt' || permission === 'prompt-with-rationale') {
    try {
      permission = (await Geolocation.requestPermissions({ permissions: ['location'] })).location;
    } catch {
      throw new GeolocationFailure(
        'permission-denied',
        'Wasel needs location permission to confirm you are at your site.',
      );
    }
  }

  if (permission !== 'granted') {
    // Android reports a "don't ask again" denial the same way as a fresh one, so
    // the recovery has to cover both: the app's own settings page.
    throw new GeolocationFailure(
      'permission-blocked',
      'Location permission is turned off for Wasel. Enable it in Settings → Apps → Wasel Attendance → Permissions.',
    );
  }

  const position = await Geolocation.getCurrentPosition({
    enableHighAccuracy: true,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maximumAge: options.maximumAgeMs ?? 0,
  }).catch((error: unknown) => {
    const code = (error as GeolocationPositionError | undefined)?.code;
    if (code === POSITION_ERROR.TIMEOUT) {
      throw new GeolocationFailure(
        'timeout',
        'Finding your location took too long. GPS is usually much faster outdoors.',
      );
    }
    throw new GeolocationFailure(
      'unavailable',
      'Your device could not get a location fix. Step outside or near a window and try again.',
    );
  });

  return toFix(position.coords, position.timestamp);
}

/**
 * Acquire a position fix.
 *
 * Native goes through the Capacitor plugin, which owns the runtime permission
 * dance; the browser goes straight to `navigator.geolocation`, because the
 * plugin's web shim cannot request permission at all and its `checkPermissions`
 * throws outright in browsers without the Permissions API. Same call site, same
 * error vocabulary, both platforms.
 */
export async function locate(options: LocateOptions = {}): Promise<GeoFix> {
  return isNative() ? locateOnDevice(options) : locateInBrowser(options);
}
