import { useCallback, useEffect, useRef, useState } from 'react';
import { GeolocationFailure, locate, type GeoErrorKind, type GeoFix } from './geolocation';

export type GeoStatus = 'idle' | 'locating' | 'ready' | 'error';

export interface GeoState {
  status: GeoStatus;
  fix: GeoFix | null;
  errorKind: GeoErrorKind | null;
  errorMessage: string | null;
}

const INITIAL: GeoState = { status: 'idle', fix: null, errorKind: null, errorMessage: null };

export interface UseGeolocationOptions {
  /** Acquire a fix as soon as the hook mounts. */
  auto?: boolean;
  /** A fix older than this is refused by `ensureFresh`. */
  maxAgeMs?: number;
}

export interface UseGeolocation extends GeoState {
  /** Acquire a fix, replacing any previous one. Rejects with `GeolocationFailure`. */
  refresh: () => Promise<GeoFix>;
  /** The current fix if it is young enough, otherwise a freshly acquired one. */
  ensureFresh: () => Promise<GeoFix>;
  isLocating: boolean;
}

/**
 * Position state for a screen.
 *
 * Two properties matter more than the rest:
 *
 *  - **Single flight.** A second `refresh()` while one is running returns the
 *    same promise. Two overlapping GPS acquisitions on Android are slower than
 *    one, and the second resolving first would let an older fix win.
 *  - **`ensureFresh` before a punch.** A fix from four minutes ago may describe a
 *    car park the user has since walked out of. The punch path re-acquires
 *    rather than sending a stale coordinate the server will judge as current.
 */
export function useGeolocation(options: UseGeolocationOptions = {}): UseGeolocation {
  const { auto = false, maxAgeMs = 45_000 } = options;

  const [state, setState] = useState<GeoState>(INITIAL);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<GeoFix> | null>(null);
  const fixRef = useRef<GeoFix | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback((): Promise<GeoFix> => {
    if (inFlightRef.current) return inFlightRef.current;

    setState((prev) => ({ ...prev, status: 'locating' }));

    const pending = locate()
      .then((fix) => {
        fixRef.current = fix;
        if (mountedRef.current) {
          setState({ status: 'ready', fix, errorKind: null, errorMessage: null });
        }
        return fix;
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof GeolocationFailure
            ? error
            : new GeolocationFailure('unavailable', 'Your location could not be determined.');
        if (mountedRef.current) {
          // The previous fix is deliberately dropped: showing a distance derived
          // from a position we can no longer confirm is worse than showing none.
          fixRef.current = null;
          setState({
            status: 'error',
            fix: null,
            errorKind: failure.kind,
            errorMessage: failure.message,
          });
        }
        throw failure;
      })
      .finally(() => {
        inFlightRef.current = null;
      });

    inFlightRef.current = pending;
    return pending;
  }, []);

  const ensureFresh = useCallback((): Promise<GeoFix> => {
    const current = fixRef.current;
    if (current && Date.now() - current.timestamp <= maxAgeMs) return Promise.resolve(current);
    return refresh();
  }, [maxAgeMs, refresh]);

  useEffect(() => {
    if (!auto) return;
    // A rejection here is already reflected in `state`; the unhandled-rejection
    // guard keeps it from reaching the console as an uncaught error.
    void refresh().catch(() => undefined);
  }, [auto, refresh]);

  return {
    ...state,
    refresh,
    ensureFresh,
    isLocating: state.status === 'locating',
  };
}
