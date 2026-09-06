import type { AuthTokens } from '@wasel/contracts';
import { env } from '../env';
import { ApiClient } from './http';

export type SignOutReason = 'refresh-failed' | 'no-refresh-token';

interface SessionListeners {
  onSessionChange?: (tokens: AuthTokens | null) => void;
  onSignOut?: (reason: SignOutReason) => void;
}

/**
 * Late-bound so the transport can be a module singleton (imported by every
 * resource module) while persistence and routing stay owned by React. The
 * alternative — constructing the client inside a provider — would force every
 * API module to become a hook.
 */
const listeners: SessionListeners = {};

export const apiClient = new ApiClient({
  baseUrl: env.apiBaseUrl,
  timeoutMs: env.apiTimeoutMs,
  onSessionChange: (tokens) => listeners.onSessionChange?.(tokens),
  onSignOut: (reason) => listeners.onSignOut?.(reason),
});

/** Returns an unsubscribe function suitable for a `useEffect` cleanup. */
export function registerSessionListeners(next: SessionListeners): () => void {
  listeners.onSessionChange = next.onSessionChange;
  listeners.onSignOut = next.onSignOut;
  return () => {
    if (listeners.onSessionChange === next.onSessionChange) delete listeners.onSessionChange;
    if (listeners.onSignOut === next.onSignOut) delete listeners.onSignOut;
  };
}
