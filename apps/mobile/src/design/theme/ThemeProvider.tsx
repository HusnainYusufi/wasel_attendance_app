import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  readStoredPreference,
  ThemeContext,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from './theme-context';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Colour applied to the Android status bar / browser chrome, per scheme. */
const META_THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#f6f7fa',
  dark: '#05070c',
};

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Applies the resolved scheme to `<html>`.
 *
 * The token layer uses `light-dark()`, so all that is needed is to narrow
 * `color-scheme` — done here by setting `data-theme`, which the token stylesheet
 * keys off. When the preference is `system` the attribute is removed entirely so
 * `color-scheme: light dark` tracks the OS with no JavaScript in the loop.
 */
function applyPreference(preference: ThemePreference, resolved: ResolvedTheme): void {
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }

  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute('content', META_THEME_COLOR[resolved]));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(systemTheme);

  // The OS scheme can change while the app is open (sunset, manual toggle).
  useEffect(() => {
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setSystemResolved(event.matches ? 'dark' : 'light');
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = preference === 'system' ? systemResolved : preference;

  useEffect(() => {
    applyPreference(preference, resolved);
  }, [preference, resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A theme that fails to persist is a papercut, never a failed action.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
