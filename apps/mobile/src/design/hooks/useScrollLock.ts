import { useEffect } from 'react';

/**
 * Freezes background scrolling while an overlay is open.
 *
 * Locking is refcounted at module scope: with two overlays open (a confirm sheet
 * launched from a modal), the inner one closing must not restore scrolling while
 * the outer one is still up.
 */
let lockCount = 0;
let restore: (() => void) | null = null;

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    if (lockCount === 0) {
      const { body } = document;
      const previousOverflow = body.style.overflow;
      const previousPaddingRight = body.style.paddingRight;
      // Compensating for the scrollbar keeps desktop review sessions from
      // shifting the whole layout left when the bar disappears.
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

      body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

      restore = () => {
        body.style.overflow = previousOverflow;
        body.style.paddingRight = previousPaddingRight;
      };
    }

    lockCount += 1;

    return () => {
      lockCount -= 1;
      if (lockCount === 0 && restore) {
        restore();
        restore = null;
      }
    };
  }, [active]);
}
