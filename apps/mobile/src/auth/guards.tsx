import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Splash } from '../design/layout/Splash';
import { useAuth } from './useAuth';

export interface GuardProps {
  /** Rendered instead of `<Outlet />` when the guard is used as a wrapper. */
  children?: ReactNode;
}

/**
 * Gate for every signed-in route.
 *
 * The `from` location rides along in router state so that a deep link opened by
 * a signed-out user lands where they meant to go after signing in, rather than
 * dumping them on the home screen.
 */
export function RequireAuth({ children }: GuardProps) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Splash />;
  if (status === 'unauthenticated') {
    return <Navigate to="/sign-in" state={{ from: location }} replace />;
  }
  return children ? <>{children}</> : <Outlet />;
}

/**
 * Admin-only gate. Nested inside `RequireAuth`, so by the time it runs the
 * session is known — a member who reaches an admin URL is redirected home
 * rather than to sign-in, which would wrongly suggest their session lapsed.
 */
export function RequireAdmin({ children }: GuardProps) {
  const { status, isAdmin } = useAuth();

  if (status === 'loading') return <Splash />;
  if (status === 'unauthenticated') return <Navigate to="/sign-in" replace />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children ? <>{children}</> : <Outlet />;
}

/** Keeps an already-signed-in user off the sign-in screen (back button, deep link). */
export function RequireGuest({ children }: GuardProps) {
  const { status } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;

  if (status === 'loading') return <Splash />;
  if (status === 'authenticated') return <Navigate to={from ?? '/'} replace />;
  return children ? <>{children}</> : <Outlet />;
}
