import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  TOAST_DANGER_DURATION,
  TOAST_DEFAULT_DURATION,
  TOAST_MAX_VISIBLE,
  ToastContext,
  type ToastOptions,
  type ToastRecord,
} from './toast-context';
import { ToastViewport } from './ToastViewport';

let sequence = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  // Timers live in a ref, not state: clearing one must never trigger a render.
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
    setToasts([]);
  }, []);

  const show = useCallback(
    (options: ToastOptions): string => {
      sequence += 1;
      const id = `toast-${sequence}`;
      const tone = options.tone ?? 'neutral';
      const duration =
        options.duration ?? (tone === 'danger' ? TOAST_DANGER_DURATION : TOAST_DEFAULT_DURATION);

      const record: ToastRecord = {
        id,
        title: options.title,
        tone,
        duration,
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.action !== undefined ? { action: options.action } : {}),
      };

      setToasts((current) => {
        const next = [...current, record];
        // Drop the oldest rather than the newest: the newest is the one that
        // describes what the user just did.
        const overflow = next.length - TOAST_MAX_VISIBLE;
        if (overflow > 0) {
          next.splice(0, overflow).forEach((dropped) => {
            const timer = timers.current.get(dropped.id);
            if (timer !== undefined) window.clearTimeout(timer);
            timers.current.delete(dropped.id);
          });
        }
        return next;
      });

      if (duration > 0) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), duration),
        );
      }

      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show, dismiss, dismissAll }), [show, dismiss, dismissAll]);

  return (
    <ToastContext value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext>
  );
}
