import { createContext } from 'react';

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds on screen. `0` pins the toast until it is dismissed. */
  duration?: number;
  action?: ToastAction;
}

export interface ToastRecord extends Required<Pick<ToastOptions, 'title' | 'tone' | 'duration'>> {
  id: string;
  description?: string;
  action?: ToastAction;
}

export interface ToastContextValue {
  /** Returns the toast id so a long-running operation can replace its own toast. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export const TOAST_DEFAULT_DURATION = 4500;
/** Errors stay longer: the user has to read them before they can act. */
export const TOAST_DANGER_DURATION = 7000;
/** Beyond three, the stack covers the content the toasts are talking about. */
export const TOAST_MAX_VISIBLE = 3;
