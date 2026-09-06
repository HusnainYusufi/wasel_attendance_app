import type { AuthUser, LoginRequest } from '@wasel/contracts';
import { createContext } from 'react';

/**
 * `loading` is the launch-time restore. It exists so the router can hold a
 * splash instead of rendering the sign-in screen for a frame and then yanking
 * it away from a user who was already signed in.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  isAdmin: boolean;
  signIn: (credentials: LoginRequest) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  /** Applies a fresh profile after a self-service change (name, password). */
  updateUser: (user: AuthUser) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
