import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

/**
 * Confines Tab focus to `containerRef` while `active`, and returns focus to
 * whatever was focused when the trap engaged.
 *
 * The previously-focused element is captured on activation rather than on mount:
 * a dialog that mounts hidden and opens later would otherwise restore focus to
 * whatever happened to be focused at mount time — usually `document.body`, which
 * strands a keyboard user at the top of the page.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options: { initialFocusRef?: RefObject<HTMLElement | null> } = {},
): void {
  const { initialFocusRef } = options;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const initial = initialFocusRef?.current ?? focusable(container)[0] ?? container;
    // Deferred a frame: on open the container is often still mid-transition and
    // `offsetParent` is null, which would make every candidate look unfocusable.
    const raf = requestAnimationFrame(() => {
      (initialFocusRef?.current ?? focusable(container)[0] ?? initial).focus({
        preventScroll: true,
      });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      const activeEl = document.activeElement;
      if (event.shiftKey && (activeEl === first || !container.contains(activeEl))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [active, containerRef, initialFocusRef]);
}
