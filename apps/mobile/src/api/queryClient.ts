import { QueryClient } from '@tanstack/react-query';
import { ApiError, isCanceled, NetworkError } from './errors';

/**
 * Retry policy.
 *
 * A 4xx is a decision the server already made — retrying it just delays the
 * error and, for a punch, risks a duplicate. Only genuine transport failures are
 * retried, and only twice: a check-in that silently retries for a minute is
 * worse than one that fails fast and lets the user tap again.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isCanceled(error)) return false;
  if (error instanceof ApiError) return error.status >= 500 && failureCount < 2;
  if (error instanceof NetworkError) return failureCount < 2;
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        // Attendance state changes on the server (a colleague's admin edit, the
        // work date rolling over), so a returning app should re-check rather
        // than show a cached "you may check in" that is no longer true.
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 30_000,
        gcTime: 5 * 60_000,
      },
      mutations: {
        // Never automatically. A retried punch is a second punch.
        retry: false,
      },
    },
  });
}
