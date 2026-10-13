import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ListFilter, LoaderCircle, MessagesSquare, Search, SearchX, Users, X } from 'lucide-react';
import {
  Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, EmptyState, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../../packages/ui/src/index.js';
import type { ChatSearchDone, ChatSearchEvent, ChatSearchHit, ChatSearchRequest, ChatSearchScope, ChatSearchWho } from '../../../packages/contracts/src/index.js';
import type { Fail, Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';
import { apiFetch } from './session.js';
import { dayEnd, dayStart, groupHits, highlightParts, streamSearch, type ChatHitGroup } from './chat-search.js';

const ALL = 'all';

type Run =
  | { readonly status: 'idle' }
  | { readonly status: 'running' | 'done' | 'stopped'; readonly groups: readonly ChatHitGroup[]; readonly scanned: number; readonly total: number; readonly done: ChatSearchDone | null }
  | { readonly status: 'failed'; readonly message: string };

interface Filters {
  /** `all`, `c:<character folder>` or `g:<group id>`. */
  readonly scope: string;
  readonly who: ChatSearchWho;
  readonly from: string;
  readonly to: string;
}

const NO_FILTERS: Filters = { scope: ALL, who: 'any', from: '', to: '' };

/**
 * Search every chat of the active profile.
 *
 * The manager reads the chats newest first and sends each hit as it finds
 * it, so the first ones show while the rest are read; a new search, or
 * leaving the page, stops the one before. Nothing typed here is kept.
 */
export function ChatSearchPage({ t, locale, fail, csrfToken }: { t: Translate; locale: LocaleCode; fail: Fail; csrfToken: string | null }) {
  const [scope, setScope] = useState<ChatSearchScope | null>(null);
  const [scopeFailed, setScopeFailed] = useState<'none' | 'noProfile' | 'failed'>('none');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/chats', { credentials: 'same-origin' });
        const payload: unknown = await response.json().catch(() => null);
        if (!alive) return;
        if (response.status === 409) { setScopeFailed('noProfile'); return; }
        if (!response.ok) { setScopeFailed('failed'); return; }
        setScope(payload as ChatSearchScope);
      } catch {
        if (alive) setScopeFailed('failed');
      }
    })();
    return () => { alive = false; };
  }, []);

  const numbers = useMemo(() => new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US'), [locale]);
  const seconds = useMemo(() => new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }), [locale]);
  const dates = useMemo(() => new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }), [locale]);
  const days = useMemo(() => new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'medium' }), [locale]);

  const start = useCallback(async (q: string, current: Filters) => {
    if (!csrfToken) return;
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    const request: ChatSearchRequest = {
      q,
      who: current.who,
      ...(current.scope.startsWith('c:') ? { character: current.scope.slice(2) } : {}),
      ...(current.scope.startsWith('g:') ? { group: current.scope.slice(2) } : {}),
      ...(dayStart(current.from) !== null ? { from: dayStart(current.from)! } : {}),
      ...(dayEnd(current.to) !== null ? { to: dayEnd(current.to)! } : {}),
    };
    setRun({ status: 'running', groups: [], scanned: 0, total: scope?.totalChats ?? 0, done: null });
    const take = (events: ChatSearchEvent[]): void => {
      if (mine.signal.aborted) return;
      setRun((state) => {
        if (state.status !== 'running') return state;
        let next = state;
        const hits = events.filter((event): event is ChatSearchHit => event.type === 'hit');
        if (hits.length > 0) next = { ...next, groups: groupHits(next.groups, hits) };
        for (const event of events) {
          if (event.type === 'progress') next = { ...next, scanned: event.scannedChats, total: event.totalChats };
          if (event.type === 'done') next = { ...next, status: 'done', scanned: event.scannedChats, total: event.totalChats, done: event };
        }
        return next;
      });
    };
    try {
      const outcome = await streamSearch(request, { csrfToken, signal: mine.signal, onEvents: take });
      if (mine.signal.aborted) return;
      if (!outcome.ok) {
        setRun({ status: 'failed', message: outcome.status === 409 && isBusy(outcome.payload) ? t('chatSearch.busy') : fail.body(outcome.payload, t('chatSearch.failed')) });
        return;
      }
      // A stream that ended without its last line was cut off.
      setRun((state) => state.status === 'running' ? { ...state, status: 'stopped' } : state);
    } catch {
      if (!mine.signal.aborted) setRun({ status: 'failed', message: t('chatSearch.failed') });
    } finally {
      if (controller.current === mine) controller.current = null;
    }
  }, [csrfToken, fail, scope?.totalChats, t]);

  const stop = (): void => {
    controller.current?.abort();
    controller.current = null;
    setRun((state) => state.status === 'running' ? { ...state, status: 'stopped' } : state);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSubmitted(q);
    void start(q, filters);
  };

  /** A filter changed: the last search runs again with it. */
  const changeFilters = (next: Filters): void => {
    setFilters(next);
    if (submitted) void start(submitted, next);
  };

  const filtered = filters.scope !== ALL || filters.who !== 'any' || filters.from !== '' || filters.to !== '';
  const groupName = (id: string): string => scope?.groups.find((group) => group.id === id)?.name ?? id;
  const empty = scope !== null && scope.totalChats === 0;

  return <div className="grid min-w-0 gap-4">
    {scopeFailed === 'noProfile' ? <Alert><AlertDescription>{t('chatSearch.noProfile')}</AlertDescription></Alert> : null}
    {scopeFailed === 'failed' ? <Alert variant="destructive"><AlertDescription>{t('chatSearch.failed')}</AlertDescription></Alert> : null}

    <Card className="sticky top-0 z-20 gap-3 py-3 shadow-sm">
      <CardContent className="grid gap-3 px-3 sm:px-4">
        <form role="search" className="flex items-center gap-2" onSubmit={submit}>
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" enterKeyHint="search" autoComplete="off" spellCheck={false} className="pl-8" value={query} maxLength={500}
              placeholder={t('chatSearch.placeholder')} aria-label={t('chatSearch.placeholder')} disabled={empty || scopeFailed === 'noProfile'}
              onChange={(event) => setQuery(event.target.value)} />
          </div>
          <Button type="submit" disabled={!csrfToken || query.trim() === '' || empty}>{t('chatSearch.submit')}</Button>
          <Button type="button" variant={filtered ? 'secondary' : 'outline'} size="icon" aria-expanded={filtersOpen} aria-label={t('chatSearch.filters')} title={t('chatSearch.filters')} onClick={() => setFiltersOpen((open) => !open)}>
            <ListFilter />
          </Button>
        </form>
        {filtersOpen ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5">
            <Label>{t('chatSearch.chatScope')}</Label>
            <Select value={filters.scope} onValueChange={(value) => changeFilters({ ...filters, scope: value })}>
              <SelectTrigger className="w-full" aria-label={t('chatSearch.chatScope')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('chatSearch.allChats')}</SelectItem>
                {scope?.groups.map((group) => <SelectItem key={`g:${group.id}`} value={`g:${group.id}`}>{t('chatSearch.groupOption', { name: group.name })}</SelectItem>)}
                {scope?.characters.map((character) => <SelectItem key={`c:${character.id}`} value={`c:${character.id}`}>{character.id}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{t('chatSearch.who')}</Label>
            <Select value={filters.who} onValueChange={(value) => changeFilters({ ...filters, who: value as ChatSearchWho })}>
              <SelectTrigger className="w-full" aria-label={t('chatSearch.who')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">{t('chatSearch.whoAny')}</SelectItem>
                <SelectItem value="me">{t('chatSearch.whoMe')}</SelectItem>
                <SelectItem value="them">{t('chatSearch.whoThem')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="chat-search-from">{t('chatSearch.from')}</Label>
            <Input id="chat-search-from" type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => changeFilters({ ...filters, from: event.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="chat-search-to">{t('chatSearch.to')}</Label>
            <Input id="chat-search-to" type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => changeFilters({ ...filters, to: event.target.value })} />
          </div>
          {filtered ? <Button type="button" variant="ghost" size="sm" className="justify-self-start sm:col-span-2 lg:col-span-4" onClick={() => changeFilters(NO_FILTERS)}><X />{t('chatSearch.clearFilters')}</Button> : null}
        </div> : null}
        <RunLine t={t} run={run} numbers={numbers} seconds={seconds} onStop={stop} />
      </CardContent>
    </Card>

    {run.status === 'failed' ? <Alert variant="destructive"><AlertDescription>{run.message}</AlertDescription></Alert> : null}
    {empty ? <EmptyState icon={<MessagesSquare />} title={t('chatSearch.noChats')} /> : null}
    {run.status === 'idle' && !empty && scopeFailed === 'none' ? <EmptyState icon={<Search />} title={t('chatSearch.idleTitle')} description={t('chatSearch.hint')} /> : null}
    {(run.status === 'done' || run.status === 'stopped') && run.groups.length === 0 ? <EmptyState icon={<SearchX />} title={t('chatSearch.noResults')} description={t('chatSearch.noResultsHint')} /> : null}

    {run.status === 'running' || run.status === 'done' || run.status === 'stopped' ? run.groups.map((group) => {
      const first = group.hits[0]!;
      const title = first.kind === 'group' ? first.group?.name ?? groupName(first.group?.id ?? '') : first.characterName ?? first.character ?? '';
      return <Card key={group.key} className="gap-0 py-0">
        <CardHeader className="gap-0.5 border-b px-3 py-2.5 sm:px-4 [.border-b]:pb-2.5">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            {first.kind === 'group' ? <Users aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : null}
            <span className="truncate">{title || t('chatSearch.groupUnknown')}</span>
            {first.kind === 'group' ? <Badge variant="outline">{t('chatSearch.group')}</Badge> : null}
          </h2>
          <p className="truncate text-xs text-muted-foreground">{t('chatSearch.chatLine', { chat: first.chat, date: days.format(first.chatModified) })}</p>
        </CardHeader>
        <ul className="divide-y">
          {group.hits.map((hit) => <li key={hit.index} className="grid gap-1 px-3 py-2.5 sm:px-4">
            <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              <span className={hit.isUser ? 'font-medium text-foreground' : 'font-medium text-primary'}>{hit.name}</span>
              <span>{hit.date === null ? t('chatSearch.noDate') : dates.format(hit.date)}</span>
              <span className="tabular-nums">#{hit.index}</span>
            </p>
            <p className="text-sm leading-relaxed break-words">
              {highlightParts(hit.snippet, hit.ranges).map((part, index) => part.match
                ? <mark key={index} className="rounded-sm bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-400/30">{part.text}</mark>
                : <span key={index}>{part.text}</span>)}
            </p>
          </li>)}
        </ul>
      </Card>;
    }) : null}
  </div>;
}

function isBusy(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { error?: { code?: unknown } }).error?.code === 'search_busy';
}

/** What the search is doing, or what it found. */
function RunLine({ t, run, numbers, seconds, onStop }: { t: Translate; run: Run; numbers: Intl.NumberFormat; seconds: Intl.NumberFormat; onStop: () => void }) {
  if (run.status === 'idle' || run.status === 'failed') return <p className="text-xs text-muted-foreground">{t('chatSearch.privacy')}</p>;
  const hits = run.groups.reduce((sum, group) => sum + group.hits.length, 0);
  if (run.status === 'running') {
    return <div aria-live="polite" className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-2"><LoaderCircle className="size-3.5 shrink-0 animate-spin" />{t('chatSearch.progress', { scanned: numbers.format(run.scanned), total: numbers.format(run.total), hits: numbers.format(hits) })}</span>
      <Button type="button" variant="outline" size="sm" onClick={onStop}>{t('chatSearch.stop')}</Button>
    </div>;
  }
  if (run.status === 'stopped') return <p aria-live="polite" className="text-xs text-muted-foreground">{t('chatSearch.stopped', { scanned: numbers.format(run.scanned), total: numbers.format(run.total), hits: numbers.format(hits) })}</p>;
  const done = run.done!;
  return <p aria-live="polite" className="text-xs text-muted-foreground">
    {t('chatSearch.done', { hits: numbers.format(done.hits), scanned: numbers.format(done.scannedChats), seconds: seconds.format(done.ms / 1000) })}
    {done.truncated ? ` ${t('chatSearch.truncated')}` : ''}
  </p>;
}
