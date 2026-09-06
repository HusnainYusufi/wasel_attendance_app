import shieldUrl from '../../assets/legend-shield.png';
import { cx } from '../utils/cx';
import styles from './Logo.module.css';

export interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  /** Renders the wordmark beside the mark. */
  withText?: boolean;
  className?: string;
}

/**
 * The Legend shield, on a light tile.
 *
 * The tile is not decoration: the shield's interior is transparent and its
 * outline is near-black, so on the app's dark theme it would merge into the
 * background and the "L" would stop reading. Setting it on white makes the mark
 * behave identically in both themes — and matches the launcher icon exactly, so
 * the thing on the home screen and the thing in the header are the same object.
 */
export function Logo({ size = 'md', withText = false, className }: LogoProps) {
  return (
    <span className={cx(styles.logo, className)}>
      <span className={cx(styles.mark, styles[size])}>
        <img src={shieldUrl} alt="" className={styles.shield} aria-hidden="true" />
      </span>
      {withText ? (
        <span className={styles.wordmark}>
          <span className={styles.name}>Legend</span>
          <span className={styles.tagline}>Attendance</span>
        </span>
      ) : null}
    </span>
  );
}
