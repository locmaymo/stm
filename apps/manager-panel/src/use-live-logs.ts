import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './session.js';
import type { LogEntry, LogSourceFilter } from '../../../packages/contracts/src/index.js';

/** How many lines the panel keeps for one source before dropping the oldest. */
const RETAINED_ENTRIES = 4_000;
const HISTORY_PAGE = 300;

export interface LiveLogs {
  readonly entries: LogEntry[];
  /** Pull the page of retained lines that precedes the oldest one held. */
  readonly loadOlder: () => void;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

export function useLiveLogs(source: LogSourceFilter): LiveLogs {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The follow request and the history request both mutate `entries`, so the
  // oldest id lives in a ref rather than being read from stale state.
  const oldestId = useRef<number | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setEntries([]);
    setHasOlder(false);
    oldestId.current = null;
    inFlight.current = false;
    const poll = async () => {
      try {
        const response = await apiFetch(`/api/v1/logs?source=${source}&after=${cursor}`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json() as { entries: LogEntry[]; nextCursor: number };
        if (controller.signal.aborted) return;
        const first = cursor === 0;
        if (payload.entries.length) {
          if (oldestId.current === null) oldestId.current = payload.entries[0]!.id;
          setEntries((current) => [...current, ...payload.entries].slice(-RETAINED_ENTRIES));
        }
        // Only the first response can tell us whether anything precedes what we
        // were given; after that the answer comes from the history endpoint.
        if (first) setHasOlder((payload.entries[0]?.id ?? 1) > 1);
        cursor = payload.nextCursor;
      } catch {
        // Retry after a temporary network failure. Aborting stops this source entirely.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [source]);

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

  return { entries, loadOlder, hasOlder, loadingOlder };
}
