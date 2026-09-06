import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { ChevronRightIcon } from '../../icons';
import { cx } from '../../utils/cx';
import styles from './ListItem.module.css';

export interface ListItemProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Adds a chevron; set it on rows that navigate. */
  chevron?: boolean;
  interactive?: boolean;
  /** Escape hatch for a router `<Link>`; supply `to`/`href` via `...rest`. */
  as?: ElementType;
  className?: string;
}

export function ListItem({
  title,
  description,
  leading,
  trailing,
  chevron = false,
  interactive = false,
  as,
  className,
  ...rest
}: ListItemProps) {
  const Component: ElementType = as ?? (interactive ? 'button' : 'div');
  const isNativeButton = Component === 'button';

  return (
    <Component
      {...rest}
      {...(isNativeButton ? { type: 'button' as const } : {})}
      className={cx(styles.item, interactive && styles.interactive, className)}
    >
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <span className={styles.body}>
        <span className={styles.title}>{title}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      {chevron ? <ChevronRightIcon size="1.15em" className={styles.chevron} /> : null}
    </Component>
  );
}

export interface ListProps extends HTMLAttributes<HTMLUListElement> {
  /** Indents dividers past a leading avatar/icon column. */
  inset?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Rows must be wrapped in `<li>` by the caller so that a row can be a link, a
 * button or static text without the list forcing one of them.
 */
export function List({ inset = false, className, children, ...rest }: ListProps) {
  return (
    <ul {...rest} role="list" className={cx(styles.group, inset && styles.groupInset, className)}>
      {children}
    </ul>
  );
}
