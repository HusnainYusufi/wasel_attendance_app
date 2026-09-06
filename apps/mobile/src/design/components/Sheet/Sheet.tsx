import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useScrollLock } from '../../hooks/useScrollLock';
import { CloseIcon } from '../../icons';
import { cx } from '../../utils/cx';
import { IconButton } from '../Button/IconButton';
import styles from './Sheet.module.css';
import { useDelayedUnmount } from './useDelayedUnmount';

const EXIT_MS = 200;

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** `bottom` for actions and pickers; `center` for a short confirm dialog. */
  placement?: 'bottom' | 'center';
  /** Sticky action row; buttons stretch to equal widths. */
  footer?: ReactNode;
  /** Set false for a destructive confirm that must be answered explicitly. */
  dismissible?: boolean;
  /** Hides the visible title while keeping it as the accessible name. */
  hideTitle?: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * Modal surface. Bottom-anchored by default because a dialog a thumb can reach
 * is worth more on a phone than one centred in the screen.
 *
 * Owns: focus trap, focus restore, Escape, background scroll lock, backdrop
 * dismissal, and an exit animation that survives `prefers-reduced-motion`.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  placement = 'bottom',
  footer,
  dismissible = true,
  hideTitle = false,
  children,
  className,
}: SheetProps) {
  const { mounted, state } = useDelayedUnmount(open, EXIT_MS);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  useScrollLock(mounted);
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open || !dismissible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, dismissible, onClose]);

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        className={styles.backdrop}
        data-state={state}
        // The backdrop is a convenience, never the only way out: the header
        // always carries a real close button, and Escape always works.
        onPointerDown={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div className={cx(styles.container, styles[placement])}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          data-state={state}
          tabIndex={-1}
          className={cx(styles.panel, className)}
        >
          {placement === 'bottom' ? <span className={styles.grabber} aria-hidden="true" /> : null}

          <div className={styles.header}>
            <div className={styles.headerText}>
              <h2 id={titleId} className={cx(styles.title, hideTitle && 'u-visually-hidden')}>
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className={styles.description}>
                  {description}
                </p>
              ) : null}
            </div>
            {dismissible ? (
              <IconButton label="Close" icon={<CloseIcon size="1.15em" />} onClick={onClose} />
            ) : null}
          </div>

          {children ? <div className={styles.body}>{children}</div> : null}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      </div>
    </>,
    document.body,
  );
}
