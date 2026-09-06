import type { ReactNode } from 'react';
import { InboxIcon } from '../../icons';
import { cx } from '../../utils/cx';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  /** `danger` is for a failed load, not for "nothing here yet". */
  tone?: 'neutral' | 'danger';
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        styles.empty,
        tone === 'danger' && styles.danger,
        compact && styles.compact,
        className,
      )}
    >
      <span className={styles.iconWrap}>{icon ?? <InboxIcon size="1.65rem" />}</span>
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
