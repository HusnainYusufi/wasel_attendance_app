import { createContext } from 'react';

/** What the user asked for. `system` defers to `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** What is actually on screen right now. */
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export const THEME_STORAGE_KEY = 'wasel.theme';

/** Kept in module scope so the boot script in index.html and this module agree. */
export function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    // Private-mode Safari and locked-down WebViews throw on access, not on read.
    return 'system';
  }
}
