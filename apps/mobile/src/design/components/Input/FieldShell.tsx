import type { ReactNode } from 'react';
import { AlertIcon } from '../../icons';
import { cx } from '../../utils/cx';
import { fieldStyles as styles } from './field-utils';

export interface FieldShellProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  optionalText?: string;
  hintId: string;
  errorId: string;
  className?: string;
  children: ReactNode;
}

/**
 * Label + hint + error scaffolding shared by every form control, so the
 * describedby wiring exists in exactly one place. An error replaces nothing —
 * the hint stays visible, because "must be 10+ characters" is still the fix for
 * "password is too short".
 */
export function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  optionalText,
  hintId,
  errorId,
  className,
  children,
}: FieldShellProps) {
  return (
    <div className={cx(styles.field, className)}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={id}>
          {label}
          {required ? (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
        {!required && optionalText ? <span className={styles.optional}>{optionalText}</span> : null}
      </div>

      {children}

      {hint || error ? (
        <div className={styles.footer}>
          {hint ? (
            <span className={styles.hint} id={hintId}>
              {hint}
            </span>
          ) : null}
          {/* `role="alert"` announces the message the moment validation fails,
              without moving focus away from the field the user is fixing. */}
          {error ? (
            <span className={styles.error} id={errorId} role="alert">
              <AlertIcon size="1em" className={styles.errorIcon} />
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
