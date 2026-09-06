import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../utils/cx';
import styles from './Card.module.css';

export type CardVariant = 'elevated' | 'outlined' | 'plain' | 'accent';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const PADDING = { none: styles.padNone, sm: styles.padSm, md: styles.padMd, lg: styles.padLg };

export interface CardProps extends HTMLAttributes<HTMLElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  /** Use for a card that is itself a control; renders a `<button>` by default. */
  interactive?: boolean;
  as?: ElementType;
  className?: string;
  children?: ReactNode;
}

export function Card({
  variant = 'elevated',
  padding = 'md',
  interactive = false,
  as,
  className,
  children,
  ...rest
}: CardProps) {
  // An interactive card must be a real control, not a div with onClick — that is
  // how a card becomes unreachable by keyboard and unnamed to a screen reader.
  const Component: ElementType = as ?? (interactive ? 'button' : 'div');
  const isNativeButton = Component === 'button';

  return (
    <Component
      {...rest}
      {...(isNativeButton ? { type: 'button' as const } : {})}
      className={cx(
        styles.card,
        styles[variant],
        PADDING[padding],
        interactive && styles.interactive,
        className,
      )}
    >
      {children}
    </Component>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cx(styles.header, className)}>
      <div className={styles.headerText}>
        <span className={styles.title}>{title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </div>
      {action}
    </div>
  );
}
