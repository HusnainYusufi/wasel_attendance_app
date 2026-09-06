import { cx } from '../../utils/cx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Class list for elements that must *look* like a Button but cannot *be* one —
 * chiefly react-router `<Link>`. Keeps the design system free of a router
 * dependency while still giving navigation the same visual treatment.
 */
export function buttonClassNames(
  options: {
    variant?: ButtonVariant;
    size?: ButtonSize;
    fullWidth?: boolean;
    className?: string;
  } = {},
): string {
  const { variant = 'primary', size = 'md', fullWidth, className } = options;
  return cx(styles.button, styles[variant], styles[size], fullWidth && styles.fullWidth, className);
}
