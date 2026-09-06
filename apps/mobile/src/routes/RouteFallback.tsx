import { Skeleton } from '../design';
import styles from './RouteFallback.module.css';

/**
 * Shown while a lazily-loaded route chunk arrives. Deliberately shaped like a
 * screen — header, then cards — so the transition is a fill-in rather than a
 * spinner followed by a layout jump.
 */
export function RouteFallback() {
  return (
    <div className={styles.fallback} aria-busy="true" aria-live="polite">
      <span className="u-visually-hidden">Loading</span>
      <Skeleton shape="rounded" width="55%" height="2rem" />
      <Skeleton shape="rounded" width="80%" height="1rem" />
      <Skeleton shape="rounded" height="9rem" />
      <Skeleton shape="rounded" height="5rem" />
      <Skeleton shape="rounded" height="5rem" />
    </div>
  );
}
