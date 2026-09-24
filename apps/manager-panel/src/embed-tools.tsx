import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Funnel, Maximize2, Minimize2, RefreshCw, Rows3, Search, X } from 'lucide-react';
import { useToast } from '../../../packages/ui/src/index.js';
import { foldForSearch, translateLogEntry, type Job, type LogEntry, type LogPage, type LogSourceFilter } from '../../../packages/contracts/src/index.js';
import type { Fail, Translate } from './i18n.js';
import { apiFetch } from './session.js';

/**
 * The manager's tools, for SillyTavern's window inside the console.
 *
 * The same four things the tools window the door serves in a tab of its own
 * offers - back up here, back up to the cloud, read the log, sign the device
 * out - asked of the console's own API instead of the door's, because this
 * window is inside the console and already holds its session. Keeping the two
 * menus alike is the point: somebody who learns one has learnt both.
 */
export function useManagerTools({ t, fail, csrfToken }: { t: Translate; fail: Fail; csrfToken: string | null }) {
  const { toast } = useToast();
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const follow = async (id: string): Promise<Job> => {
    for (;;) {
      const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(t('console.toolsFailed'));
      const job = await response.json() as Job;
      if (job.state !== 'running' && job.state !== 'queued') return job;
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (!alive.current) return job;
    }
  };

  const backup = async (target: 'local' | 'cloud') => {
    if (working || !csrfToken) return;
    setWorking(true);
    try {
      const response = target === 'local'
        ? await apiFetch('/api/v1/backups', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ kind: 'scheduled' }) })
        : await apiFetch('/api/v1/r2/sync', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json().catch(() => null) as { jobId?: string; unchanged?: boolean } | null;
      if (!response.ok) { toast({ title: fail.body(payload, t('console.toolsFailed')), tone: 'destructive' }); return; }
      if (payload?.unchanged) { toast({ title: t('console.toolsUnchanged'), tone: 'success' }); return; }
      if (!payload?.jobId) { toast({ title: t('console.toolsDone'), tone: 'success' }); return; }
      toast({ title: t('console.toolsStarted') });
      const job = await follow(payload.jobId);
      if (job.state === 'succeeded') toast({ title: t('console.toolsDone'), tone: 'success' });
      else if (job.state !== 'running' && job.state !== 'queued') toast({ title: job.error ?? t('console.toolsFailed'), tone: 'destructive' });
    } catch {
      toast({ title: t('console.toolsFailed'), tone: 'destructive' });
    } finally {
      if (alive.current) setWorking(false);
    }
  };

  return { working, backup };
}

/** Smallest the panel is let shrink to, so its header and a few lines always show. */
const LOGS_MIN = { width: 280, height: 160 };
const LOGS_SIZE_KEY = 'stm-tools-logs-size';
const LOGS_COMPACT_KEY = 'stm-tools-logs-compact';

function readJson<T>(key: string): T | null {
  try { return JSON.parse(window.localStorage.getItem(key) ?? 'null') as T | null; } catch { return null; }
}
function writeJson(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* kept for this visit only */ }
}

/**
 * The manager's log over SillyTavern, read only while it is open.
 *
 * The console has a log of its own, but it is behind this window; bringing it
 * forward would mean leaving SillyTavern to read three lines. This is the same
 * panel the door's tools window has, and it behaves the same way:
 *
 * - Compact or detailed, in one button. Compact drops the time and the source,
 *   which is what a phone has room for, so a phone starts compact and a
 *   desktop starts detailed; a choice made either way is remembered.
 * - Resized by its edges: the grip in the middle of the top edge on a phone,
 *   and the top edge, the left edge or the corner between them with a mouse.
 *   Or the whole screen, from the header.
 */
export function ToolsLogs({ t, catalog, onClose }: { t: Translate; catalog: Record<string, unknown>; onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const cursor = useRef(0);
  const list = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const [generation, setGeneration] = useState(0);
  const [compact, setCompact] = useState<boolean>(() => readJson<boolean>(LOGS_COMPACT_KEY) ?? window.matchMedia('(max-width: 640px)').matches);
  // Only the sides that were dragged: a height set on a phone, where the
  // panel is as wide as the screen, must not make it that narrow on a desktop.
  const [size, setSize] = useState<{ width?: number; height?: number }>(() => readJson(LOGS_SIZE_KEY) ?? {});
  const [maximized, setMaximized] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Which source is shown. A row of choices inside the panel rather than a
  // menu: a menu is drawn in a layer of its own, and that layer sits under
  // this window.
  const [filterOpen, setFilterOpen] = useState(false);
  const [source, setSource] = useState<LogSourceFilter>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    cursor.current = 0;
    setEntries([]);
    const tick = async () => {
      if (cancelled) return;
      if (!document.hidden) {
        try {
          const response = await apiFetch(`/api/v1/logs?after=${cursor.current}`, { credentials: 'same-origin' });
          if (response.ok) {
            const page = await response.json() as LogPage;
            cursor.current = page.nextCursor;
            if (!cancelled && page.entries.length > 0) {
              const element = list.current;
              const stick = element ? element.scrollTop + element.clientHeight >= element.scrollHeight - 40 : true;
              setEntries((current) => [...current, ...page.entries].slice(-600));
              if (stick) window.requestAnimationFrame(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; });
            }
          }
        } catch {
          // The next tick tries again.
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [generation]);

  const toggleCompact = () => { setCompact((value) => { writeJson(LOGS_COMPACT_KEY, !value); return !value; }); };
  /*
   * Dragging an edge. The panel is held to the bottom right, so pulling the
   * top edge up or the left edge left is what makes it bigger. The frame
   * under it would take the pointer the moment it crossed, so frames stop
   * listening for as long as the drag lasts.
   */
  const resize = (edges: { top?: boolean; left?: boolean }) => (event: ReactPointerEvent<HTMLElement>) => {
    const element = panel.current;
    if (!element) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = element.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
    const max = { width: window.innerWidth - 16, height: window.innerHeight - 16 };
    document.documentElement.dataset.resizing = '';
    setMaximized(false);
    const target = event.currentTarget;
    let next = size;
    const move = (moved: PointerEvent) => {
      next = {
        ...next,
        ...(edges.left ? { width: Math.min(max.width, Math.max(LOGS_MIN.width, start.width + start.x - moved.clientX)) } : {}),
        ...(edges.top ? { height: Math.min(max.height, Math.max(LOGS_MIN.height, start.height + start.y - moved.clientY)) } : {}),
      };
      setSize(next);
    };
    const end = () => {
      delete document.documentElement.dataset.resizing;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      writeJson(LOGS_SIZE_KEY, next);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  // Matched against what is on screen and the English under it, like the
  // console's own log, so either language finds a line.
  const needle = foldForSearch(query.trim());
  const shown = entries.filter((entry) => (source === 'all' || entry.source === source)
    && (!needle || foldForSearch(`${entry.source} ${entry.message} ${translateLogEntry(entry, catalog)}`).includes(needle)));
  const sources: ReadonlyArray<{ id: LogSourceFilter; label: string }> = [
    { id: 'all', label: t('console.allLogs') },
    { id: 'sillytavern', label: 'SillyTavern' },
    { id: 'manager', label: 'Manager' },
    { id: 'cloudflared', label: 'Cloudflare Tunnel' },
    { id: 'installer', label: t('console.installer') },
    { id: 'backup', label: t('nav.backups') },
  ];
  const closeSearch = () => { setQuery(''); setSearchOpen(false); };
  const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const style = maximized ? undefined : {
    ...(size.width ? { '--logs-width': `${size.width}px` } : {}),
    ...(size.height ? { '--logs-height': `${size.height}px` } : {}),
  } as CSSProperties;
  return <section ref={panel} className="embed-logs" data-maximized={maximized || undefined} style={style} role="dialog" aria-label={t('console.openLogs')}>
    {maximized ? null : <>
      <span className="embed-logs-grip" role="separator" aria-orientation="horizontal" aria-label={t('console.logsResize')} title={t('console.logsResize')} onPointerDown={resize({ top: true })}><i aria-hidden="true" /></span>
      <span className="embed-logs-edge-left" aria-hidden="true" onPointerDown={resize({ left: true })} />
      <span className="embed-logs-corner" aria-hidden="true" onPointerDown={resize({ top: true, left: true })} />
    </>}
    <header>
      <strong>{t('console.openLogs')}</strong>
      <button type="button" onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))} aria-pressed={searchOpen} aria-label={t('console.searchLogs')} title={t('console.searchLogs')}><Search aria-hidden="true" /></button>
      <button type="button" onClick={() => setFilterOpen((value) => !value)} aria-pressed={filterOpen || source !== 'all'} aria-label={t('console.logSource')} title={t('console.logSource')}><Funnel aria-hidden="true" /></button>
      <button type="button" onClick={toggleCompact} aria-pressed={compact} title={compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}><Rows3 aria-hidden="true" /><span>{compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}</span></button>
      <button type="button" onClick={() => setGeneration((value) => value + 1)} aria-label={t('console.toolsRefresh')} title={t('console.toolsRefresh')}><RefreshCw aria-hidden="true" /></button>
      <button type="button" onClick={() => setMaximized((value) => !value)} aria-label={maximized ? t('console.logsRestore') : t('console.logsMaximize')} title={maximized ? t('console.logsRestore') : t('console.logsMaximize')}>{maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button>
      <button type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><X aria-hidden="true" /></button>
    </header>
    {filterOpen ? <div className="embed-logs-filter" role="radiogroup" aria-label={t('console.logSource')}>
      {sources.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={source === entry.id} onClick={() => setSource(entry.id)}>{entry.label}</button>)}
    </div> : null}
    {searchOpen ? <div className="embed-logs-search">
      <Search aria-hidden="true" />
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeSearch(); } }} placeholder={t('console.searchLogs')} aria-label={t('console.searchLogs')} />
    </div> : null}
    <div className="embed-logs-lines" ref={list}>
      {shown.length === 0
        ? <p className="embed-logs-empty">{needle || source !== 'all' ? t('console.noLogMatches') : t('console.toolsLogsEmpty')}</p>
        : shown.map((entry) => <p key={entry.id} data-level={entry.level}>
          {compact ? null : <time>{time(entry.timestamp)}</time>}
          {compact ? null : <span className="embed-logs-source">{entry.source}</span>}
          {translateLogEntry(entry, catalog)}
        </p>)}
    </div>
  </section>;
}
