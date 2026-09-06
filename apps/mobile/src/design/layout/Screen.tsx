import type { ReactNode } from 'react';
import { IconButton } from '../components/Button/IconButton';
import { ChevronLeftIcon } from '../icons';
import { cx } from '../utils/cx';
import styles from './Screen.module.css';

export interface ScreenProps {
  title: string;
  eyebrow?: string;
  subtitle?: ReactNode;
  /** Trailing control in the header row — a filter, an add button. */
  action?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Page scaffold: safe-area-aware header, one column, consistent gutters.
 *
 * The `<h1>` lives here so every route has exactly one, in the same place,
 * without each screen re-deciding its own heading level.
 */
export function Screen({
  title,
  eyebrow,
  subtitle,
  action,
  onBack,
  backLabel = 'Back',
  children,
  className,
}: ScreenProps) {
  return (
    <div className={cx(styles.screen, className)}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          {onBack ? (
            <IconButton
              className={styles.back}
              label={backLabel}
              icon={<ChevronLeftIcon size="1.35em" />}
              onClick={onBack}
            />
          ) : null}
          <div className={styles.headerText}>
            {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
            <h1 className={styles.title}>{title}</h1>
          </div>
          {action ? <div className={styles.action}>{action}</div> : null}
        </div>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </header>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
