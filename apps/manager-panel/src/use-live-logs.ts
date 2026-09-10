import { useEffect, useState } from 'react';
import type { LogEntry, LogSourceFilter } from '../../../packages/contracts/src/index.js';

export function useLiveLogs(source: LogSourceFilter): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setEntries([]);
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/logs?source=${source}&after=${cursor}`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json() as { entries: LogEntry[]; nextCursor: number };
        if (controller.signal.aborted) return;
        if (payload.entries.length) setEntries((current) => [...current, ...payload.entries].slice(-300));
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
  return entries;
}
