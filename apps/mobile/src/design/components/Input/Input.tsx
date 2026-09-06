import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from '../../icons';
import { cx } from '../../utils/cx';
import { IconButton } from '../Button/IconButton';
import { describedBy, fieldStyles as styles } from './field-utils';
import { FieldShell } from './FieldShell';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> {
  /** Always rendered; never a placeholder standing in for a label. */
  label: string;
  hint?: string;
  /** Presence of a message is what marks the field invalid. */
  error?: string;
  size?: 'md' | 'lg';
  iconStart?: ReactNode;
  /** Adds a show/hide toggle to a `type="password"` field. */
  revealToggle?: boolean;
  /**
   * Marks the field optional. Opt-in, not automatic: labelling every
   * non-required field "Optional" turns the word into wallpaper and buys the
   * reader nothing.
   */
  optionalText?: string;
  className?: string;
  fieldClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    size = 'md',
    iconStart,
    revealToggle = false,
    optionalText,
    className,
    fieldClassName,
    id: idProp,
    type = 'text',
    disabled,
    required,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp ?? `input-${reactId}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [revealed, setRevealed] = useState(false);

  const isPassword = type === 'password';
  const showReveal = isPassword && revealToggle;
  const resolvedType = showReveal && revealed ? 'text' : type;

  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      optionalText={optionalText}
      hintId={hintId}
      errorId={errorId}
      className={fieldClassName}
    >
      <div
        className={cx(
          styles.control,
          styles[size],
          error && styles.invalid,
          disabled && styles.disabled,
        )}
      >
        {iconStart ? <span className={styles.adornment}>{iconStart}</span> : null}
        <input
          {...rest}
          ref={ref}
          id={id}
          type={resolvedType}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint, error, hintId, errorId)}
          className={cx(styles.input, className)}
        />
        {showReveal ? (
          <IconButton
            className={styles.trailingButton}
            size="md"
            label={revealed ? 'Hide password' : 'Show password'}
            icon={revealed ? <EyeOffIcon size="1.15em" /> : <EyeIcon size="1.15em" />}
            onClick={() => setRevealed((v) => !v)}
            disabled={disabled}
          />
        ) : null}
      </div>
    </FieldShell>
  );
});
