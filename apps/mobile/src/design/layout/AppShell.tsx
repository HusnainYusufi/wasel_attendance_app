import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../utils/cx';
import styles from './AppShell.module.css';

export interface TabItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Matches only the exact path; use for the index route. */
  end?: boolean;
}

export interface AppShellProps {
  tabs: ReadonlyArray<TabItem>;
  children: ReactNode;
}

/**
 * The app frame: one scrolling region plus a fixed bottom tab bar.
 *
 * `data-app-shell="tabs"` is read by global CSS to lift the portalled toast
 * viewport clear of the bar.
 */
export function AppShell({ tabs, children }: AppShellProps) {
  return (
    <div className={styles.shell} data-app-shell="tabs">
      <main className={styles.main}>{children}</main>

      <nav className={styles.tabbar} aria-label="Primary">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => cx(styles.tab, isActive && styles.tabActive)}
          >
            {/* NavLink sets aria-current="page" on the active tab, which is what
                announces the current section; the colour and the rule above the
                icon are the sighted equivalent. */}
            <span className={styles.tabIcon} aria-hidden="true">
              {tab.icon}
            </span>
            <span className={styles.tabLabel}>{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
