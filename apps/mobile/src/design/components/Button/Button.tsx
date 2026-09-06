import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../utils/cx';
import { Spinner } from '../Spinner/Spinner';
import { buttonClassNames, type ButtonSize, type ButtonVariant } from './button-styles';
import styles from './Button.module.css';

export type { ButtonSize, ButtonVariant };

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner, sets `aria-busy`, and hard-disables the control. */
  loading?: boolean;
  fullWidth?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  className?: string;
}

const SPINNER_SIZE = { sm: 'sm', md: 'sm', lg: 'md', xl: 'lg' } as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    iconStart,
    iconEnd,
    disabled,
    className,
    children,
    type = 'button',
    onClick,
    ...rest
  },
  ref,
) {
  // `disabled` is the guard, not a click-handler early-return: a disabled button
  // fires no click at all, so a double-tap during an in-flight mutation cannot
  // submit twice even if React has not re-rendered yet.
  const isDisabled = disabled === true || loading;

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={loading ? undefined : onClick}
      className={cx(
        buttonClassNames({ variant, size, fullWidth, className }),
        loading && styles.loading,
      )}
    >
      {/* The spinner takes the leading icon's place rather than replacing the
          label. A button that shows only a spinner loses the one word that
          says what is happening — "Checking out…" — exactly when the user is
          least sure whether their tap registered. */}
      {loading ? (
        <span className={styles.icon}>
          <Spinner size={SPINNER_SIZE[size]} />
        </span>
      ) : iconStart ? (
        <span className={styles.icon}>{iconStart}</span>
      ) : null}
      <span className={styles.label}>{children}</span>
      {iconEnd && !loading ? <span className={styles.icon}>{iconEnd}</span> : null}
    </button>
  );
});
