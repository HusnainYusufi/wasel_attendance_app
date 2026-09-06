import { useQueryClient } from '@tanstack/react-query';
import { Role, type AuthUser, type LoginRequest } from '@wasel/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiClient, authApi, isApiError, registerSessionListeners } from '../api';
import { AuthContext, type AuthStatus } from './auth-context';
import { clearSession, loadSession, saveSession } from './session-storage';
import type { AuthTokens } from '@wasel/contracts';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  // Mirrors of the live session, read from async callbacks that must not be
  // re-created every time the user object changes. Synced after commit, never
  // during render.
  const userRef = useRef<AuthUser | null>(null);
  const tokensRef = useRef<AuthTokens | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const endSession = useCallback(async () => {
    apiClient.setSession(null);
    tokensRef.current = null;
    setUser(null);
    setStatus('unauthenticated');
    await clearSession();
    // Attendance and admin data belong to the person who just left. Clearing
    // rather than invalidating means the next user cannot see a stale frame of
    // the previous one's data while their own request is in flight.
    queryClient.clear();
  }, [queryClient]);

  /**
   * Bridges the transport's session events into React.
   *
   * Registered in a layout effect-free `useEffect` that runs before the restore
   * below resolves, so a refresh triggered by that very first request still
   * finds a listener attached.
   */
  useEffect(() => {
    return registerSessionListeners({
      onSessionChange: (tokens) => {
        tokensRef.current = tokens;
        const current = userRef.current;
        if (tokens && current) {
          // Rotated tokens must be persisted immediately: an app killed between
          // rotation and the next write would come back holding a refresh token
          // the server has already retired.
          void saveSession({ tokens, user: current });
        } else if (!tokens) {
          void clearSession();
        }
      },
      onSignOut: () => {
        void endSession();
      },
    });
  }, [endSession]);

  // --- restore on launch ---------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      const stored = await loadSession();
      if (cancelled) return;

      if (!stored) {
        setStatus('unauthenticated');
        return;
      }

      // Optimistic: the app is usable from the stored profile immediately, and
      // the network check below only ever downgrades it.
      apiClient.setSession(stored.tokens);
      tokensRef.current = stored.tokens;
      setUser(stored.user);
      setStatus('authenticated');

      try {
        const fresh = await authApi.me(controller.signal);
        if (!cancelled) {
          setUser(fresh);
          const tokens = tokensRef.current;
          // Tokens may have rotated during this very call; persist the current
          // pair, not the ones read from disk a moment ago.
          if (tokens) void saveSession({ tokens, user: fresh });
        }
      } catch (error) {
        if (cancelled) return;
        // 401 already ran through the refresh path inside the client; reaching
        // here with one means refresh failed and `onSignOut` has fired. Any
        // other failure — offline, server down, endpoint absent — must not
        // evict a session the user legitimately holds.
        if (isApiError(error) && error.status === 403) {
          void endSession();
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [endSession]);

  // --- actions -------------------------------------------------------------

  const signIn = useCallback(async (credentials: LoginRequest): Promise<AuthUser> => {
    const response = await authApi.login(credentials);
    apiClient.setSession(response.tokens);
    tokensRef.current = response.tokens;
    // Persisted before React state so a crash mid-render still leaves a
    // recoverable session on disk.
    await saveSession({ tokens: response.tokens, user: response.user });
    setUser(response.user);
    setStatus('authenticated');
    return response.user;
  }, []);

  const signOut = useCallback(async () => {
    const refreshToken = apiClient.getRefreshToken();
    try {
      // Best effort: revoking server-side is desirable but never blocks the
      // user from leaving. An offline sign-out must still work.
      await authApi.logout(refreshToken);
    } catch {
      // Intentionally ignored — see above.
    }
    await endSession();
  }, [endSession]);

  const updateUser = useCallback((next: AuthUser) => {
    setUser(next);
    const tokens = tokensRef.current;
    if (tokens) void saveSession({ tokens, user: next });
  }, []);

  const value = useMemo(
    () => ({
      status,
      user,
      isAdmin: user?.role === Role.ADMIN,
      signIn,
      signOut,
      updateUser,
    }),
    [status, user, signIn, signOut, updateUser],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
