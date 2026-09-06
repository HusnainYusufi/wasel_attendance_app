import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Keeps a component mounted through its exit animation.
 *
 * `useLayoutEffect` rather than `useEffect`: the mount must be committed before
 * the browser paints, or the panel appears for one frame at its final position
 * and the enter animation reads as a flicker.
 *
 * The unmount timer is deliberately timer-based rather than `animationend`-based:
 * under `prefers-reduced-motion` the global reset collapses the animation to
 * 0.01ms, and a paused or never-started animation fires no event at all — which
 * would leave the overlay mounted forever.
 */
export function useDelayedUnmount(
  open: boolean,
  exitMs: number,
): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open);
  const timerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (open) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      /* eslint-disable-next-line react-hooks/set-state-in-effect --
         Mounting an overlay is the "synchronise with something outside React"
         case the rule exempts in spirit: `open` is owned by the caller and the
         portal node must exist before the next paint. The obvious alternative,
         adjusting state during render, is what this replaced — under React 19
         StrictMode it settled on a stale `mounted` and the sheet never opened. */
      setMounted(true);
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setMounted(false);
    }, exitMs);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open, exitMs]);

  return { mounted, state: open ? 'open' : 'closed' };
}
