import { createPortal } from 'react-dom';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from '../../icons';
import { cx } from '../../utils/cx';
import { IconButton } from '../Button/IconButton';
import type { ToastRecord, ToastTone } from './toast-context';
import styles from './Toast.module.css';

const ICONS: Record<ToastTone, typeof InfoIcon> = {
  neutral: InfoIcon,
  success: CheckIcon,
  warning: AlertIcon,
  danger: AlertIcon,
};

export interface ToastViewportProps {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
}

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.viewport}>
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div
            key={toast.id}
            className={cx(styles.toast, styles[toast.tone])}
            data-state="open"
            // A failure interrupts; everything else waits for a natural pause in
            // the screen reader's output.
            role={toast.tone === 'danger' ? 'alert' : 'status'}
            aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
          >
            <span className={styles.accentBar} aria-hidden="true" />
            <Icon size="1.15rem" className={styles.icon} />
            <div className={styles.body}>
              <span className={styles.title}>{toast.title}</span>
              {toast.description ? (
                <span className={styles.description}>{toast.description}</span>
              ) : null}
              {toast.action ? (
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => {
                    toast.action?.onClick();
                    onDismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>
            <IconButton
              className={styles.close}
              size="sm"
              label="Dismiss notification"
              icon={<CloseIcon size="1.05em" />}
              onClick={() => onDismiss(toast.id)}
            />
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
