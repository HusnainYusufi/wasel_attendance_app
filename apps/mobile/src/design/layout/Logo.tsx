import { cx } from '../utils/cx';
import styles from './Logo.module.css';

export interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  /** Renders the wordmark beside the mark. */
  withText?: boolean;
  className?: string;
}

/**
 * The app mark: a stylised pin whose stem is a clock hand — the two things this
 * product is about, place and time. Drawn rather than imported so it inherits
 * the accent token and never falls out of sync with the theme.
 */
export function Logo({ size = 'md', withText = false, className }: LogoProps) {
  return (
    <span className={cx(styles.logo, className)}>
      <span className={cx(styles.mark, styles[size])} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="62%" height="62%" fill="none" aria-hidden="true">
          <path
            d="M12 21.2c4.1-4.4 6.2-7.7 6.2-10.4a6.2 6.2 0 1 0-12.4 0c0 2.7 2.1 6 6.2 10.4Z"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
          <path
            d="M12 7.7v3.4l2.1 1.3"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {withText ? (
        <span className={styles.wordmark}>
          <span className={styles.name}>Wasel</span>
          <span className={styles.tagline}>Attendance</span>
        </span>
      ) : null}
    </span>
  );
}
