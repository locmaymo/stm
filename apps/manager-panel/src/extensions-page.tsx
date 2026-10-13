import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleArrowUp, Ellipsis, ExternalLink, Link2, LoaderCircle, Plus, Power, PowerOff, Puzzle, RefreshCw, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import {
  Alert, AlertDescription, Badge, Button, Card, CardAction, CardContent, CardHeader, ConfirmDialog, DataTable,
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Field, initialQuery, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useToast,
  type DataTableColumn, type DataTableLabels, type TableQuery,
} from '../../../packages/ui/src/index.js';
import { formatBytes, translateStep, type ExtensionInfo, type ExtensionList, type ExtensionReconnectPreview, type ExtensionScope, type ExtensionTarget, type Job } from '../../../packages/contracts/src/index.js';
import { logCatalog, type Fail, type MessageKey, type Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';
import { apiFetch } from './session.js';

/** How long a removed extension waits in the trash; the server's `TRASH_DAYS`. */
const TRASH_DAYS = 7;

type Confirmation =
  | { readonly kind: 'rollback'; readonly item: ExtensionInfo }
  | { readonly kind: 'remove'; readonly item: ExtensionInfo }
  | { readonly kind: 'toggle'; readonly item: ExtensionInfo; readonly enabled: boolean };

/**
 * The third-party extensions the active profile runs, and looking after them.
 *
 * The list is read off the disk by the manager, so it answers the same with
 * SillyTavern stopped. Looking for updates is asked for on every visit and
 * answered by the manager only when the last look is over an hour old; the
 * button asks regardless. Anything that takes a while is a job on the
 * manager, so leaving the page does not stop it, and coming back finds it
 * still going. Nothing is deleted from here: removing moves an extension to
 * the trash at the bottom of the page.
 */
export function ExtensionsPage({ t, locale, labels, fail, csrfToken }: { t: Translate; locale: LocaleCode; labels: DataTableLabels; fail: Fail; csrfToken: string | null }) {
  const { toast } = useToast();
  const [list, setList] = useState<ExtensionList | null>(null);
  const [failed, setFailed] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [preview, setPreview] = useState<ExtensionReconnectPreview | null>(null);
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

  /**
   * Ask the manager for a change and say how it went.
   *
   * `done` is the sentence for success; null says nothing, which is what a
   * look for updates wants. True when it succeeded.
   */
  const ask = useCallback(async (path: string, body: unknown, done: MessageKey | null, options: { readonly quiet?: boolean; readonly method?: 'POST' | 'DELETE'; readonly onJob?: (job: Job) => Promise<void> } = {}): Promise<boolean> => {
    if (!csrfToken) return false;
    const response = await apiFetch(`/api/v1/extensions/${path}`, { method: options.method ?? 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null) as { job?: Job | null } | null;
    if (!response.ok) {
      if (!options.quiet) toast({ title: fail.body(payload, t('extensions.taskFailed')), tone: 'destructive' });
      await load();
      return false;
    }
    if (payload?.job) {
      const finished = await follow(payload.job);
      if (finished.state === 'failed') {
        await load();
        toast({ title: fail.of(finished.errorCode, finished.error, t('extensions.taskFailed')), tone: 'destructive' });
        return false;
      }
      if (finished.state !== 'succeeded') { await load(); return false; }
      await options.onJob?.(finished);
    }
    await load();
    if (done) toast({ title: t(done), tone: 'success' });
    return true;
  }, [csrfToken, fail, follow, load, t, toast]);

  const updateAll = async () => {
    if (!await ask('update', { all: true }, null)) return;
    // An update of everything succeeds while single extensions in it refuse;
    // what is still behind afterwards is what did not move.
    const stillBehind = (await load())?.extensions.filter((item) => (item.update?.behind ?? 0) > 0).length ?? 0;
    toast(stillBehind > 0 ? { title: t('extensions.updatePartial'), tone: 'destructive' } : { title: t('extensions.updateDone'), tone: 'success' });
  };

  const reconnect = (item: ExtensionInfo) => void ask('reconnect', { scope: item.scope, name: item.name }, null, {
    onJob: async (finished) => {
      const response = await apiFetch(`/api/v1/extensions/reconnect/${encodeURIComponent(finished.id)}`, { credentials: 'same-origin' });
      if (response.ok && alive.current) setPreview(await response.json() as ExtensionReconnectPreview);
    },
  });

  const closePreview = (apply: boolean) => {
    const waiting = preview;
    setPreview(null);
    if (!waiting) return;
    if (apply) void ask(`reconnect/${encodeURIComponent(waiting.id)}/apply`, {}, 'extensions.reconnectDone');
    else void ask(`reconnect/${encodeURIComponent(waiting.id)}`, {}, null, { method: 'DELETE', quiet: true });
  };

  // On arrival: the list, then a job somebody else started, or a look for
  // updates if the last one is old - the manager decides which it is.
  useEffect(() => {
    void (async () => {
      const first = await load();
      if (!first) return;
      if (first.job) { await follow(first.job); await load(); return; }
      if (first.gitAvailable && first.extensions.some((item) => item.hasGit)) await ask('check', {}, null, { quiet: true });
    })();
    // Once per visit, and again once the session token is known.
  }, [csrfToken]);

  const busy = job !== null;
  const timeFormat = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateFormat = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const scopeLabel = (scope: ExtensionScope) => t(scope === 'user' ? 'extensions.scopeUser' : 'extensions.scopeGlobal');
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
        <span className="text-xs text-muted-foreground md:hidden">{[scopeLabel(item.scope), item.version].filter(Boolean).join(' · ')}</span>
        <StatusChips t={t} fail={fail} item={item} />
      </span>,
    },
    { id: 'scope', header: t('extensions.columnScope'), sortable: true, showFrom: 'md', cell: (item) => <span className="whitespace-nowrap text-muted-foreground">{scopeLabel(item.scope)}</span> },
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
        const canReconnect = canGit && !item.hasGit && item.homePage !== null;
        return <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('extensions.rowMenu', { name: item.displayName })} disabled={busy}><Ellipsis /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canUpdate ? <DropdownMenuItem onSelect={() => void ask('update', target, 'extensions.updateDone')}><CircleArrowUp />{t('extensions.update')}</DropdownMenuItem> : null}
            {item.canRollBack ? <DropdownMenuItem onSelect={() => setConfirming({ kind: 'rollback', item })}><RotateCcw />{t('extensions.rollBack')}</DropdownMenuItem> : null}
            {canReconnect ? <DropdownMenuItem onSelect={() => reconnect(item)}><Link2 />{t('extensions.reconnect')}</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => setConfirming({ kind: 'toggle', item, enabled: !item.enabled })}>{item.enabled ? <PowerOff /> : <Power />}{t(item.enabled ? 'extensions.turnOff' : 'extensions.turnOn')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming({ kind: 'remove', item })}><Trash2 />{t('extensions.remove')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>;
      },
    },
  ];

  const toolbar = <div className="flex flex-wrap gap-2">
    {canGit ? <Button variant="outline" size="sm" disabled={busy || !csrfToken} onClick={() => setInstallOpen(true)}><Plus />{t('extensions.install')}</Button> : null}
    {canGit ? <Button variant="outline" size="sm" disabled={busy || !csrfToken} onClick={() => void ask('check', { force: true }, null)}><RefreshCw />{t('extensions.checkUpdates')}</Button> : null}
    {updatable > 0 ? <Button size="sm" disabled={busy || !csrfToken} onClick={() => void updateAll()}><CircleArrowUp />{t('extensions.updateAll', { count: updatable })}</Button> : null}
  </div>;

  const confirmation = confirming ? confirmationText(t, confirming) : null;
  const trash = list?.trash ?? [];

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

    {trash.length > 0 ? <Card>
      <CardHeader className="grid-rows-[auto] items-center"><h2 className="panel-title"><Trash2 />{t('extensions.trashTitle')}</h2></CardHeader>
      <CardContent>
        <ul className="grid divide-y">
          {trash.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
            <span className="grid min-w-0 gap-0.5">
              <span className="font-medium break-all">{item.displayName}</span>
              <span className="text-xs text-muted-foreground">{[scopeLabel(item.scope), formatBytes(item.bytes), t('extensions.trashExpires', { date: dateFormat.format(new Date(item.expiresAt)) })].join(' · ')}</span>
            </span>
            <Button variant="outline" size="sm" disabled={busy || !csrfToken} onClick={() => void ask('restore', { id: item.id }, 'extensions.trashRestored')}><Undo2 />{t('extensions.trashRestore')}</Button>
          </li>)}
        </ul>
      </CardContent>
    </Card> : null}

    <ConfirmDialog
      open={confirming !== null}
      onOpenChange={(open) => { if (!open) setConfirming(null); }}
      title={confirmation?.title ?? ''}
      description={confirmation?.body ?? ''}
      confirmLabel={confirmation?.action ?? ''}
      cancelLabel={t('common.cancel')}
      tone={confirming?.kind === 'remove' ? 'destructive' : 'default'}
      onConfirm={() => {
        if (!confirming) return;
        const target: ExtensionTarget = { scope: confirming.item.scope, name: confirming.item.name };
        if (confirming.kind === 'rollback') void ask('rollback', target, 'extensions.rollBackDone');
        else if (confirming.kind === 'remove') void ask('remove', target, 'extensions.removeDone');
        else void ask('enable', { ...target, enabled: confirming.enabled }, 'extensions.toggleDone');
      }}
    />
    <InstallDialog t={t} open={installOpen} onOpenChange={setInstallOpen} hasProfile={list !== null} onInstall={(body) => ask('install', body, 'extensions.installDone')} />
    <ReconnectDialog t={t} preview={preview} onClose={closePreview} />
  </div>;
}

function confirmationText(t: Translate, confirming: Confirmation): { title: string; body: string; action: string } {
  const name = confirming.item.displayName;
  if (confirming.kind === 'rollback') return { title: t('extensions.rollBackTitle', { name }), body: t('extensions.rollBackBody'), action: t('extensions.rollBack') };
  if (confirming.kind === 'remove') return { title: t('extensions.removeTitle', { name }), body: t('extensions.removeBody', { days: TRASH_DAYS }), action: t('extensions.remove') };
  return confirming.enabled
    ? { title: t('extensions.turnOnTitle', { name }), body: t('extensions.toggleBody'), action: t('extensions.turnOn') }
    : { title: t('extensions.turnOffTitle', { name }), body: t('extensions.toggleBody'), action: t('extensions.turnOff') };
}

function InstallDialog({ t, open, onOpenChange, hasProfile, onInstall }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; hasProfile: boolean; onInstall: (body: { url: string; branch: string; scope: ExtensionScope }) => Promise<boolean> }) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [scope, setScope] = useState<ExtensionScope>('user');
  const submit = () => {
    if (!url.trim()) return;
    onOpenChange(false);
    void onInstall({ url: url.trim(), branch: branch.trim(), scope }).then((installed) => { if (installed) { setUrl(''); setBranch(''); } });
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t('extensions.installTitle')}</DialogTitle>
        <DialogDescription>{t('extensions.installDescription')}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <Field label={t('extensions.installUrl')}>
            <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} />
          </Field>
          <Field label={t('extensions.installBranch')} hint={t('extensions.installBranchHint')}>
            <Input autoComplete="off" spellCheck={false} value={branch} onChange={(event) => setBranch(event.target.value)} />
          </Field>
          <Field label={t('extensions.installScope')}>
            <Select value={scope} onValueChange={(value) => setScope(value as ExtensionScope)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user" disabled={!hasProfile}>{t('extensions.scopeUser')}</SelectItem>
                <SelectItem value="global">{t('extensions.scopeGlobal')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <button type="submit" hidden />
        </form>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
        <Button onClick={submit} disabled={!url.trim()}><Plus />{t('extensions.installSubmit')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ReconnectDialog({ t, preview, onClose }: { t: Translate; preview: ExtensionReconnectPreview | null; onClose: (apply: boolean) => void }) {
  const rows: Array<[string, readonly string[]]> = preview ? [
    [t('extensions.reconnectAdded', { count: preview.added }), preview.samples.added],
    [t('extensions.reconnectChanged', { count: preview.changed }), preview.samples.changed],
    [t('extensions.reconnectRemoved', { count: preview.removed }), preview.samples.removed],
  ] : [];
  return <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) onClose(false); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('extensions.reconnectTitle', { name: preview?.displayName ?? '' })}</DialogTitle>
        <DialogDescription className="break-all">{t('extensions.reconnectBody', { url: preview?.url ?? '' })}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-3 text-sm">
        {rows.map(([label, samples]) => <div key={label} className="grid gap-1">
          <span className="font-medium">{label}</span>
          {samples.length > 0 ? <span className="font-mono text-xs break-all text-muted-foreground">{samples.join(', ')}</span> : null}
        </div>)}
        {preview ? <span className="text-muted-foreground">{t('extensions.reconnectUnchanged', { count: preview.unchanged })}</span> : null}
        {preview && preview.removed > 0 ? <Alert><AlertDescription>{t('extensions.reconnectRemovedHint')}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onClose(false)}>{t('common.cancel')}</Button>
        <Button onClick={() => onClose(true)}><Link2 />{t('extensions.reconnectApply')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
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
