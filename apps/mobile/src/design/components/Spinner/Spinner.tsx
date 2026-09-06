import { cx } from '../../utils/cx';
import styles from './Spinner.module.css';

const SIZES = { sm: '1rem', md: '1.25rem', lg: '1.75rem', xl: '2.5rem' } as const;

export interface SpinnerProps {
  size?: keyof typeof SIZES;
  /**
   * Accessible label. Supply it when the spinner is the only thing announcing
   * that work is in flight; omit it inside a control that already sets
   * `aria-busy`, so a screen reader is not told twice.
   */
  label?: string;
  className?: string;
}

export function Spinner({ size = 'md', label, className }: SpinnerProps) {
  const edge = SIZES[size];
  return (
    <svg
      className={cx(styles.spinner, className)}
      width={edge}
      height={edge}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
    >
      <circle
        className={styles.track}
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <circle
        className={styles.head}
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
      />
    </svg>
  );
}
