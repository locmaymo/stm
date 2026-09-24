import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './session.js';
import type { LogEntry, LogPage, LogSourceFilter } from '../../../packages/contracts/src/index.js';

/** How many lines the panel keeps for one source before dropping the oldest. */
const RETAINED_ENTRIES = 4_000;
const HISTORY_PAGE = 300;

export interface LiveLogs {
  readonly entries: LogEntry[];
  /** The cursor to ask the next page from, for whoever is doing the asking. */
  readonly cursor: () => number;
  /** Take a page the console's own poll collected, for the source it asked about. */
  readonly accept: (page: LogPage, source: LogSourceFilter) => void;
  /** Pull the page of retained lines that precedes the oldest one held. */
  readonly loadOlder: () => void;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

/**
 * Hold one log source, filled by somebody else's request.
 *
 * This used to follow the log itself, on a timer of its own - one and a half
 * seconds with the log open, twenty with it closed. That is a second
 * connection for a screen that was already asking the manager how it was
 * doing, and through a Cloudflare Worker it was the most expensive thing the
 * console did: forty requests a minute, of which the ones carrying nothing new
 * were seventy-nine bytes each.
 *
 * So the tail rides along with the status poll, and what is left here is the
 * buffer: where the cursor has got to, what is held, and how to reach further
 * back than the manager volunteered. Reading older lines is still a request of
 * its own, because it happens when somebody scrolls up rather than on a clock.
 */
export function useLiveLogs(source: LogSourceFilter): LiveLogs {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The follow request and the history request both mutate `entries`, so the
  // oldest id lives in a ref rather than being read from stale state.
  const oldestId = useRef<number | null>(null);
  const inFlight = useRef(false);
  /*
   * Where the tail has got to, in a ref rather than in state.
   *
   * What asks for the next page is a timer outside this hook, and a timer can
   * fire before React has re-rendered with a cursor that was just set. From a
   * ref it reads the cursor the last accepted page actually ended at, so a
   * fast clock cannot ask twice from the same place and show a line twice.
   */
  const cursor = useRef(0);
  /** The newest line held, so a page that overlaps one already taken adds nothing twice. */
  const newestId = useRef(0);
  const current = useRef(source);

  const accept = useCallback((page: LogPage, pageSource: LogSourceFilter): void => {
    /*
     * A page for another source is dropped. The status poll can be in flight
     * when the filter changes, and its answer - lines from every source - used
     * to land in the freshly emptied buffer of the one just chosen.
     */
    if (pageSource !== current.current) return;
    const first = cursor.current === 0;
    const fresh = page.entries.filter((entry) => entry.id > newestId.current);
    if (fresh.length > 0) {
      if (oldestId.current === null) oldestId.current = fresh[0]!.id;
      newestId.current = fresh.at(-1)!.id;
      setEntries((held) => [...held, ...fresh].slice(-RETAINED_ENTRIES));
    }
    // Only the first answer can say whether anything precedes what we were
    // given; after that the answer comes from the history endpoint.
    if (first) setHasOlder((page.entries[0]?.id ?? 1) > 1);
    cursor.current = Math.max(cursor.current, page.nextCursor);
  }, []);

  /*
   * A different source is a different log: what is held belongs to the old
   * one. The new one is asked for straight away rather than on the status
   * poll's next tick, which is seconds away at best - long enough for the
   * filter to look as if it had emptied the log.
   */
  useEffect(() => {
    current.current = source;
    cursor.current = 0;
    newestId.current = 0;
    oldestId.current = null;
    inFlight.current = false;
    setEntries([]);
    setHasOlder(false);
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch(`/api/v1/logs?after=0&source=${source}`, { credentials: 'same-origin' });
        if (!response.ok || cancelled) return;
        accept(await response.json() as LogPage, source);
      } catch {
        // The status poll brings it instead.
      }
    })();
    return () => { cancelled = true; };
  }, [source, accept]);

  const loadOlder = useCallback(() => {
    if (inFlight.current || !hasOlder) return;
    const before = oldestId.current;
    if (before === null || before <= 1) { setHasOlder(false); return; }
    inFlight.current = true;
    setLoadingOlder(true);
    void (async () => {
      try {
        const response = await apiFetch(`/api/v1/logs?source=${source}&before=${before}&limit=${HISTORY_PAGE}`, { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json() as { entries: LogEntry[]; hasMore: boolean };
        if (payload.entries.length === 0) { setHasOlder(false); return; }
        oldestId.current = payload.entries[0]!.id;
        setEntries((current) => [...payload.entries, ...current].slice(0, RETAINED_ENTRIES));
        setHasOlder(payload.hasMore);
      } catch {
        // Leave hasOlder set so the reader can try again.
      } finally {
        inFlight.current = false;
        setLoadingOlder(false);
      }
    })();
  }, [source, hasOlder]);

  const readCursor = useCallback(() => cursor.current, []);

  return { entries, cursor: readCursor, accept, loadOlder, hasOlder, loadingOlder };
}
