import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleArrowUp, Ellipsis, ExternalLink, LoaderCircle, Puzzle, RefreshCw, RotateCcw } from 'lucide-react';
import {
  Alert, AlertDescription, Badge, Button, Card, CardAction, CardContent, CardHeader, ConfirmDialog, DataTable,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, initialQuery, useToast,
  type DataTableColumn, type DataTableLabels, type TableQuery,
} from '../../../packages/ui/src/index.js';
import { formatBytes, translateStep, type ExtensionInfo, type ExtensionList, type ExtensionTarget, type Job } from '../../../packages/contracts/src/index.js';
import { logCatalog, type Fail, type Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';
import { apiFetch } from './session.js';

type Action = 'check' | 'update' | 'rollback';

/**
 * The third-party extensions the active profile runs, and keeping them current.
 *
 * The list is read off the disk by the manager, so it answers the same with
 * SillyTavern stopped. Looking for updates is asked for on every visit and
 * answered by the manager only when the last look is over an hour old; the
 * button asks regardless. Updates and roll backs are jobs on the manager, so
 * leaving the page does not stop one, and coming back finds it still going.
 */
export function ExtensionsPage({ t, locale, labels, fail, csrfToken }: { t: Translate; locale: LocaleCode; labels: DataTableLabels; fail: Fail; csrfToken: string | null }) {
  const { toast } = useToast();
  const [list, setList] = useState<ExtensionList | null>(null);
  const [failed, setFailed] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [rollBackTarget, setRollBackTarget] = useState<ExtensionInfo | null>(null);
  const [query, setQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 25, sort: 'name', direction: 'asc' }));
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (): Promise<ExtensionList | null> => {
    try {
      const response = await apiFetch('/api/v1/extensions', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('extensions request failed');
      const next = await response.json() as ExtensionList;
      if (alive.current) { setList(next); setFailed(false); }
      return next;
    } catch {
      if (alive.current) setFailed(true);
      return null;
    }
  }, []);

  /** Follow a job to its end, showing its step as it goes. */
  const follow = useCallback(async (started: Job): Promise<Job> => {
    let current = started;
    while (alive.current && (current.state === 'running' || current.state === 'queued')) {
      setJob(current);
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 800));
      const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(current.id)}`, { credentials: 'same-origin' });
      if (!response.ok) break;
      current = await response.json() as Job;
    }
    if (alive.current) setJob(null);
    return current;
  }, []);

  const run = useCallback(async (action: Action, body: ExtensionTarget | { all: true } | { force?: boolean }, quiet = false) => {
    if (!csrfToken) return;
    const response = await apiFetch(`/api/v1/extensions/${action}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null) as { job: Job | null } | null;
    if (!response.ok) {
      if (!quiet) toast({ title: fail.body(payload, t('extensions.taskFailed')), tone: 'destructive' });
      return;
    }
    if (!payload?.job) return;
    const finished = await follow(payload.job);
    const next = await load();
    if (finished.state === 'failed') {
      toast({ title: fail.of(finished.errorCode, finished.error, t('extensions.taskFailed')), tone: 'destructive' });
      return;
    }
    if (finished.state !== 'succeeded' || action === 'check') return;
    if (action === 'rollback') { toast({ title: t('extensions.rollBackDone'), tone: 'success' }); return; }
    // An update of everything succeeds while single extensions in it refuse;
    // what is still behind afterwards is what did not move.
    const stillBehind = 'all' in body ? next?.extensions.filter((item) => (item.update?.behind ?? 0) > 0).length ?? 0 : 0;
    toast(stillBehind > 0 ? { title: t('extensions.updatePartial'), tone: 'destructive' } : { title: t('extensions.updateDone'), tone: 'success' });
  }, [csrfToken, fail, follow, load, t, toast]);

  // On arrival: the list, then a job somebody else started, or a look for
  // updates if the last one is old - the manager decides which it is.
  useEffect(() => {
    void (async () => {
      const first = await load();
      if (!first) return;
      if (first.job) { await follow(first.job); await load(); return; }
      if (first.gitAvailable && first.extensions.some((item) => item.hasGit)) await run('check', {}, true);
    })();
    // Once per visit; `run` changes identity with the session token only.
  }, [csrfToken]);

  const busy = job !== null;
  const timeFormat = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateFormat = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const scopeLabel = (item: ExtensionInfo) => t(item.scope === 'user' ? 'extensions.scopeUser' : 'extensions.scopeGlobal');
  const updatable = list?.extensions.filter((item) => (item.update?.behind ?? 0) > 0).length ?? 0;
  const canGit = list?.gitAvailable === true;
  const columns: DataTableColumn<ExtensionInfo>[] = [
    {
      id: 'name',
      header: t('common.name'),
      sortable: true,
      // Where it lives and its version ride under the name on a phone, where
      // there is no room for columns of their own.
      cell: (item) => <span className="grid min-w-0 justify-items-start gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-medium break-all" title={item.name}>{item.displayName}</span>
          {item.homePage ? <a href={item.homePage} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground" aria-label={`${t('extensions.homePage')}: ${item.displayName}`}><ExternalLink className="size-3.5" /></a> : null}
        </span>
        <span className="text-xs text-muted-foreground md:hidden">{[scopeLabel(item), item.version].filter(Boolean).join(' · ')}</span>
        <StatusChips t={t} fail={fail} item={item} />
      </span>,
    },
    { id: 'scope', header: t('extensions.columnScope'), sortable: true, showFrom: 'md', cell: (item) => <span className="whitespace-nowrap text-muted-foreground">{scopeLabel(item)}</span> },
    { id: 'version', header: t('extensions.columnVersion'), showFrom: 'md', cell: (item) => <span className="whitespace-nowrap text-muted-foreground" title={item.git?.commit}>{item.version ?? '-'}</span> },
    { id: 'updated', header: t('extensions.columnUpdated'), sortable: true, showFrom: 'sm', cell: (item) => <span className="whitespace-nowrap text-muted-foreground">{item.git?.committedAt ? dateFormat.format(new Date(item.git.committedAt)) : '-'}</span> },
    {
      id: 'size',
      header: t('extensions.columnSize'),
      sortable: true,
      align: 'end',
      showFrom: 'sm',
      cell: (item) => <span className="whitespace-nowrap text-muted-foreground" title={item.dependencyBytes > 0 ? t('extensions.sizeDetail', { size: formatBytes(item.bytes), dependencies: formatBytes(item.dependencyBytes) }) : undefined}>{formatBytes(item.bytes + item.dependencyBytes)}</span>,
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('extensions.actions')}</span>,
      align: 'end',
      headClassName: 'w-12',
      cell: (item) => {
        const target: ExtensionTarget = { scope: item.scope, name: item.name };
        const canUpdate = canGit && item.git !== null;
        if (!canUpdate && !item.canRollBack) return null;
        return <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('extensions.rowMenu', { name: item.displayName })} disabled={busy}><Ellipsis /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canUpdate ? <DropdownMenuItem onSelect={() => void run('update', target)}><CircleArrowUp />{t('extensions.update')}</DropdownMenuItem> : null}
            {item.canRollBack ? <DropdownMenuItem onSelect={() => setRollBackTarget(item)}><RotateCcw />{t('extensions.rollBack')}</DropdownMenuItem> : null}
          </DropdownMenuContent>
        </DropdownMenu>;
      },
    },
  ];

  const toolbar = canGit ? <div className="flex flex-wrap gap-2">
    <Button variant="outline" size="sm" disabled={busy || !csrfToken} onClick={() => void run('check', { force: true })}><RefreshCw />{t('extensions.checkUpdates')}</Button>
    {updatable > 0 ? <Button size="sm" disabled={busy || !csrfToken} onClick={() => void run('update', { all: true })}><CircleArrowUp />{t('extensions.updateAll', { count: updatable })}</Button> : null}
  </div> : undefined;

  return <div className="grid min-w-0 gap-4">
    <Card>
      <CardHeader className="grid-rows-[auto] items-center">
        <h2 className="panel-title"><Puzzle />{t('extensions.title')}</h2>
        <CardAction className="row-span-1 self-center"><Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => void load()}><RefreshCw /></Button></CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {failed ? <Alert variant="destructive"><AlertDescription>{t('extensions.loadFailed')}</AlertDescription></Alert> : null}
        {list && !list.gitAvailable ? <Alert><AlertDescription>{t('extensions.gitMissing')}</AlertDescription></Alert> : null}
        {job ? <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite"><LoaderCircle className="size-4 animate-spin" />{translateStep(job.step, logCatalog(locale), job.stepCode, job.stepParams)}</p> : null}
        <DataTable
          rows={list?.extensions ?? []}
          columns={columns}
          rowKey={(item) => `${item.scope}/${item.name}`}
          query={query}
          onQueryChange={setQuery}
          labels={labels}
          loading={list === null && !failed}
          toolbar={toolbar}
          searchText={(item) => `${item.displayName} ${item.name} ${item.author ?? ''}`}
          sortValue={(item, column) => column === 'name' ? item.displayName.toLowerCase()
            : column === 'scope' ? item.scope
              : column === 'updated' ? item.git?.committedAt ?? ''
                : column === 'size' ? item.bytes + item.dependencyBytes
                  : null}
          empty={<EmptyState icon={<Puzzle />} title={t('extensions.emptyTitle')} description={t('extensions.emptyDescription')} />}
        />
        <p className="text-xs text-muted-foreground">
          {canGit && list?.extensions.some((item) => item.hasGit) ? <>{list.checkedAt ? t('extensions.checkedAt', { when: timeFormat.format(new Date(list.checkedAt)) }) : t('extensions.neverChecked')}{' · '}</> : null}
          {t('extensions.scopeNote')}
        </p>
      </CardContent>
    </Card>
    <ConfirmDialog
      open={rollBackTarget !== null}
      onOpenChange={(open) => { if (!open) setRollBackTarget(null); }}
      title={t('extensions.rollBackTitle', { name: rollBackTarget?.displayName ?? '' })}
      description={t('extensions.rollBackBody')}
      confirmLabel={t('extensions.rollBack')}
      cancelLabel={t('common.cancel')}
      tone="default"
      onConfirm={() => { if (rollBackTarget) void run('rollback', { scope: rollBackTarget.scope, name: rollBackTarget.name }); }}
    />
  </div>;
}

function StatusChips({ t, fail, item }: { t: Translate; fail: Fail; item: ExtensionInfo }) {
  const behind = item.update?.behind ?? 0;
  const problem = item.update?.problem ?? null;
  const chips = [
    behind > 0 ? <Badge key="update" variant="secondary" className="bg-(--success-background) text-(--success)" title={t('extensions.updateAvailableHint', { count: behind })}>{t('extensions.updateAvailable')}</Badge> : null,
    problem ? <Badge key="problem" variant="outline" title={fail.of(problem, null, t('extensions.checkProblem'))}>{t('extensions.checkProblem')}</Badge> : null,
    item.shadowed ? <Badge key="shadowed" variant="outline" title={t('extensions.shadowedHint')}>{t('extensions.shadowed')}</Badge> : null,
    !item.enabled ? <Badge key="disabled" variant="secondary">{t('extensions.disabled')}</Badge> : null,
    !item.hasGit ? <Badge key="git" variant="outline" title={t('extensions.noGitHint')}>{t('extensions.noGit')}</Badge> : null,
  ].filter(Boolean);
  return chips.length > 0 ? <span className="flex flex-wrap gap-1">{chips}</span> : null;
}
