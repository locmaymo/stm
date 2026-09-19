import { useEffect, useRef } from 'react';

/**
 * Ask again every so often, but only while somebody is there to read it.
 *
 * Two rules, both of which the console's timers used to break. Nothing is
 * asked while the page is hidden - a console left open in a background tab is
 * a console nobody is looking at, and the browser's own timer throttling is
 * not a policy, it is a side effect that differs per browser and per platform.
 * And the moment the page is looked at again, the question is asked at once
 * rather than after the rest of an interval, so coming back to the tab never
 * shows a stale screen.
 *
 * Only one request is in flight at a time. A poll that takes longer than the
 * interval - a machine under load, a link from a phone - used to start a
 * second one on top of it, and then a third, each one making the last worse.
 */
export function usePoll(run: () => void | Promise<void>, options: { readonly intervalMs: number; readonly enabled?: boolean }): void {
  const { intervalMs, enabled = true } = options;
  // Held in a ref so that a handler closing over fresh state does not restart
  // the timer on every render, which would poll on every render instead.
  const latest = useRef(run);
  latest.current = run;

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (stopped || busy || document.hidden) return;
      busy = true;
      try {
        await latest.current();
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, intervalMs);
    const onVisible = (): void => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled]);
}
