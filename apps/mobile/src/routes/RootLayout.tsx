import { Suspense, useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import {
  AppShell,
  ClockIcon,
  DownloadIcon,
  HistoryIcon,
  ShieldIcon,
  type TabItem,
} from '../design';
import { paths } from './paths';
import { RouteFallback } from './RouteFallback';

const MEMBER_TABS: TabItem[] = [
  { to: paths.home, label: 'Today', icon: <ClockIcon size="1.4rem" />, end: true },
  { to: paths.history, label: 'History', icon: <HistoryIcon size="1.4rem" /> },
];

/**
 * Admin keeps the member tabs and gains two. Export is top-level rather than
 * buried under Admin because it is the task the buyer performs most often.
 */
const ADMIN_TABS: TabItem[] = [
  ...MEMBER_TABS,
  { to: paths.admin, label: 'Admin', icon: <ShieldIcon size="1.4rem" />, end: true },
  { to: paths.adminExport, label: 'Export', icon: <DownloadIcon size="1.4rem" /> },
];

export function RootLayout() {
  const { isAdmin } = useAuth();
  const { pathname } = useLocation();
  const tabs = useMemo(() => (isAdmin ? ADMIN_TABS : MEMBER_TABS), [isAdmin]);

  /**
   * Every route shares one scroll container, so without this a tab switch lands
   * the next screen at the previous screen's scroll offset — tap Admin after
   * scrolling Today and the dashboard opens halfway down, with its heading
   * already off screen. `data-app-shell` is the shell's existing published hook
   * (global CSS reads it too), so this does not reach into AppShell's internals.
   */
  useEffect(() => {
    document.querySelector('[data-app-shell] > main')?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <AppShell tabs={tabs}>
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
    </AppShell>
  );
}
