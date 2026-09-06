import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import styles from './BareLayout.module.css';
import { RouteFallback } from './RouteFallback';

/** Chrome-free frame for routes that must not show navigation (sign-in, 404). */
export function BareLayout() {
  return (
    <div className={styles.bare}>
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
    </div>
  );
}
