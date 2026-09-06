import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../utils/cx';
import styles from './IconButton.module.css';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  /** Required: an icon-only control has no visible text to name it. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'plain' | 'outlined';
  className?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', variant = 'plain', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.iconButton, styles[size], styles[variant], className)}
    >
      {icon}
    </button>
  );
});
