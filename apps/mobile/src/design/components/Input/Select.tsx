import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from '../../icons';
import { cx } from '../../utils/cx';
import { describedBy, fieldStyles as styles } from './field-utils';
import { FieldShell } from './FieldShell';

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'size'> {
  label: string;
  hint?: string;
  error?: string;
  size?: 'md' | 'lg';
  /** Marks the field optional; opt-in, so the word stays meaningful. */
  optionalText?: string;
  className?: string;
  fieldClassName?: string;
  children: ReactNode;
}

/**
 * A native `<select>` in a design-system shell. The OS picker is the right
 * control on a phone — it is thumb-reachable, localised, and already familiar —
 * so only the trigger is restyled.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hint,
    error,
    size = 'md',
    optionalText,
    className,
    fieldClassName,
    id: idProp,
    disabled,
    required,
    children,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp ?? `select-${reactId}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

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
        <span className={styles.selectWrap}>
          <select
            {...rest}
            ref={ref}
            id={id}
            disabled={disabled}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(hint, error, hintId, errorId)}
            className={cx(styles.select, className)}
          >
            {children}
          </select>
          <ChevronDownIcon size="1.15em" className={styles.selectChevron} />
        </span>
      </div>
    </FieldShell>
  );
});
