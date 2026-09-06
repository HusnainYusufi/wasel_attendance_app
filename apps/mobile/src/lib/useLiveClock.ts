import { useEffect, useState } from 'react';

/**
 * A clock that ticks on the second boundary.
 *
 * A naive `setInterval(fn, 1000)` drifts: each tick fires a little after the
 * previous one, so the displayed second eventually skips one. This schedules the
 * next tick at the *next real second*, which keeps the display in step with the
 * user's own watch, and re-syncs after the tab has been backgrounded.
 *
 * The tab-visibility listener matters on a phone: an Android WebView throttles
 * timers hard in the background, so a screen returned to after ten minutes would
 * otherwise show a stale time for up to a second — long enough to be seen.
 */
export function useLiveClock(enabled = true): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      const current = new Date();
      setNow(current);
      timer = setTimeout(tick, 1000 - (current.getTime() % 1000));
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      tick();
    };

    tick();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  return now;
}
