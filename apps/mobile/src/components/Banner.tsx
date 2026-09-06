import type { ReactNode } from 'react';
import { AlertIcon, CheckIcon, InfoIcon, cx } from '../design';
import styles from './Banner.module.css';

export type BannerTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BannerProps {
  tone?: BannerTone;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links; wraps on a narrow screen rather than overflowing. */
  action?: ReactNode;
  icon?: ReactNode;
  /** Suppresses the default icon without needing a custom one. */
  hideIcon?: boolean;
  className?: string;
}

const DEFAULT_ICON: Record<BannerTone, ReactNode> = {
  neutral: <InfoIcon size="1.15rem" />,
  accent: <InfoIcon size="1.15rem" />,
  success: <CheckIcon size="1.15rem" />,
  warning: <AlertIcon size="1.15rem" />,
  danger: <AlertIcon size="1.15rem" />,
};

/**
 * A persistent, in-flow message.
 *
 * Distinct from a toast, which disappears, and from `EmptyState`, which claims a
 * whole region: this is for a condition the user has to act on *while looking at
 * the thing it concerns* — "you are 9.6 km from Head Office" belongs next to the
 * CHECK IN button, not in a strip that vanishes after four seconds.
 *
 * `danger` and `warning` get `role="alert"` so a failure announces itself the
 * moment it renders; the calmer tones stay out of the live region, because an
 * informational banner interrupting a screen reader mid-sentence is noise.
 */
export function Banner({
  tone = 'neutral',
  title,
  description,
  action,
  icon,
  hideIcon = false,
  className,
}: BannerProps) {
  const assertive = tone === 'danger' || tone === 'warning';

  return (
    <div
      className={cx(styles.banner, styles[tone], className)}
      role={assertive ? 'alert' : undefined}
    >
      {hideIcon ? null : (
        <span className={styles.icon} aria-hidden="true">
          {icon ?? DEFAULT_ICON[tone]}
        </span>
      )}
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        {description ? <p className={styles.description}>{description}</p> : null}
        {action ? <div className={styles.action}>{action}</div> : null}
      </div>
    </div>
  );
}
