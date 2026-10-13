import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Ellipsis, KeyRound, List, LoaderCircle, Network, RefreshCw, Route, Send } from 'lucide-react';
import {
  Alert, AlertDescription, Badge, Button, Card, CardAction, CardContent, CardHeader, ConfirmDialog,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, Input,
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, useToast,
} from '../../../packages/ui/src/index.js';
import {
  connectionApiProvider, connectionProviderName, connectionTargetKey,
  type ConnectionKey, type ConnectionModel, type ConnectionModelList, type ConnectionProfile, type ConnectionProxy, type ConnectionsOverview, type ConnectionTarget, type ConnectionTestResult,
} from '../../../packages/contracts/src/index.js';
import type { Fail, MessageKey, Translate } from './i18n.js';
import type { LocaleCode } from './preferences.js';
import { apiFetch } from './session.js';

/** A target with the words it is shown by, for titles and toasts. */
interface Named {
  readonly target: ConnectionTarget;
  readonly name: string;
}

/** A one-token message waiting for the reader to say yes. */
interface Sending extends Named {
  readonly model: string;
}

/** How many models the list shows before asking for a narrower search. */
const MODELS_SHOWN = 200;

/**
 * The keys, proxies and connection profiles SillyTavern keeps, and whether
 * they still work.
 *
 * Read off the profile's files by the manager, so the page answers the same
 * with SillyTavern stopped. Keys arrive masked and proxy passwords not at all.
 * A test asks the provider for its model list (and balance, where it has
 * one); a one-token message is only ever sent from its own button, after a
 * warning, because it costs a little. SillyTavern stays the place these are
 * used; this page is the overview and the tester.
 */
export function ConnectionsPage({ t, locale, fail, csrfToken }: { t: Translate; locale: LocaleCode; fail: Fail; csrfToken: string | null }) {
  const { toast } = useToast();
  const [overview, setOverview] = useState<ConnectionsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [modelsOf, setModelsOf] = useState<Named | null>(null);
  const [sending, setSending] = useState<Sending | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/v1/connections', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('connections request failed');
      const next = await response.json() as ConnectionsOverview;
      if (alive.current) { setOverview(next); setFailed(false); }
    } catch {
      if (alive.current) setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const money = useCallback((amount: number, currency: string) => {
    try {
      return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
    } catch {
      return `${amount} ${currency}`;
    }
  }, [locale]);

  const post = useCallback(async (path: string, body: unknown): Promise<unknown> => {
    if (!csrfToken) return null;
    const response = await apiFetch(`/api/v1/connections/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      toast({ title: fail.body(payload, t('connections.testFailed')), tone: 'destructive' });
      return null;
    }
    return payload;
  }, [csrfToken, fail, t, toast]);

  /** Put one result in place without reading the whole page again. */
  const remember = useCallback((target: ConnectionTarget, result: ConnectionTestResult) => {
    setOverview((current) => current ? { ...current, tests: { ...current.tests, [connectionTargetKey(target)]: result } } : current);
  }, []);

  const test = useCallback(async ({ target, name }: Named, model?: string) => {
    const key = connectionTargetKey(target);
    setTesting((current) => new Set(current).add(key));
    try {
      const payload = await post('test', model ? { target, send: { model } } : { target }) as { result?: ConnectionTestResult } | null;
      if (!payload?.result || !alive.current) return;
      remember(target, payload.result);
      toast(resultToast(t, name, payload.result, money, model ?? null));
    } finally {
      if (alive.current) setTesting((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }, [money, post, remember, t, toast]);

  const testAll = async () => {
    setTestingAll(true);
    try {
      const payload = await post('test-all', {}) as { tests?: Record<string, ConnectionTestResult> } | null;
      if (!payload?.tests || !alive.current) return;
      const tests = payload.tests;
      setOverview((current) => current ? { ...current, tests: { ...current.tests, ...tests } } : current);
      const results = Object.values(tests);
      const broken = results.filter((result) => result.code !== 'ok').length;
      toast(broken > 0
        ? { title: t('connections.testAllProblems', { count: broken, total: results.length }), tone: 'destructive' }
        : { title: t('connections.testAllOk', { total: results.length }), tone: 'success' });
    } finally {
      if (alive.current) setTestingAll(false);
    }
  };

  const profileNames = new Map((overview?.profiles ?? []).map((profile) => [profile.id, profile.name]));
  const tests = overview?.tests ?? {};
  const needsSillyTavern = Object.values(tests).some((result) => result.code === 'needs_sillytavern') && overview?.sillyTavernRunning === false;
  const controls = (named: Named, extra?: { readonly model?: string | null }) => {
    const key = connectionTargetKey(named.target);
    return <TestControls t={t} named={named} result={tests[key] ?? null} busy={testing.has(key) || testingAll} canAct={csrfToken !== null}
      onTest={() => void test(named)} onModels={() => setModelsOf(named)}
      onSend={extra?.model ? () => setSending({ ...named, model: extra.model ?? '' }) : undefined} />;
  };
  const status = (target: ConnectionTarget) => <TestStatus t={t} locale={locale} result={tests[connectionTargetKey(target)] ?? null} money={money} />;
  const empty = overview !== null && overview.keys.length + overview.proxies.length + overview.profiles.length === 0;

  return <div className="grid min-w-0 gap-4">
    {failed ? <Alert variant="destructive"><AlertDescription>{t('connections.loadFailed')}</AlertDescription></Alert> : null}
    {overview && !overview.profile ? <Alert><AlertDescription>{t('connections.noProfile')}</AlertDescription></Alert> : null}
    {overview?.legacySecrets ? <Alert><AlertDescription>{t('connections.legacySecrets')}</AlertDescription></Alert> : null}
    {overview?.unreadable.map((file) => <Alert key={file} variant="destructive"><AlertDescription>{t('connections.unreadable', { file: file === 'secrets' ? 'secrets.json' : 'settings.json' })}</AlertDescription></Alert>)}
    {needsSillyTavern ? <Alert><AlertDescription>{t('connections.needsSillyTavern')}</AlertDescription></Alert> : null}

    {overview?.profile && !empty ? <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">{t('connections.testsNote')}</p>
      <Button size="sm" disabled={testingAll || !csrfToken} onClick={() => void testAll()}>
        {testingAll ? <LoaderCircle className="animate-spin" /> : <Activity />}{t(testingAll ? 'connections.testAllRunning' : 'connections.testAll')}
      </Button>
    </div> : null}

    <Section icon={<KeyRound />} title={t('connections.keysTitle')} action={<Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => void load()}><RefreshCw /></Button>} loading={overview === null && !failed}
      empty={<EmptyState icon={<KeyRound />} title={t('connections.keysEmpty')} description={t('connections.keysEmptyHint')} />}>
      {overview && overview.keys.length > 0 ? <KeyGroups t={t} keys={overview.keys} profileNames={profileNames} status={status} controls={controls} /> : null}
    </Section>

    <Section icon={<Route />} title={t('connections.proxiesTitle')} loading={overview === null && !failed}
      empty={<p className="text-sm text-muted-foreground">{t('connections.proxiesEmpty')}</p>}>
      {overview && overview.proxies.length > 0 ? <ul className="grid divide-y">{overview.proxies.map((proxy) => {
        const target: ConnectionTarget = { kind: 'proxy', name: proxy.name };
        return <ProxyRow key={proxy.name} t={t} proxy={proxy} profileNames={profileNames} status={status(target)} controls={controls({ target, name: proxy.name })} />;
      })}</ul> : null}
    </Section>

    <Section icon={<Network />} title={t('connections.profilesTitle')} loading={overview === null && !failed}
      empty={<p className="text-sm text-muted-foreground">{t('connections.profilesEmpty')}</p>}>
      {overview && overview.profiles.length > 0 ? <ul className="grid divide-y">{overview.profiles.map((profile) => {
        const target: ConnectionTarget = { kind: 'profile', id: profile.id };
        return <ProfileRow key={profile.id} t={t} profile={profile} status={status(target)} controls={controls({ target, name: profile.name }, { model: profile.mode === 'cc' ? profile.model : null })} />;
      })}</ul> : null}
    </Section>

    <p className="text-xs text-muted-foreground">{t('connections.readNote')}</p>

    <ModelsSheet t={t} named={modelsOf} onClose={() => setModelsOf(null)} onSend={(model) => { if (modelsOf) setSending({ ...modelsOf, model }); }} canSend={csrfToken !== null} />
    <ConfirmDialog
      open={sending !== null}
      onOpenChange={(open) => { if (!open) setSending(null); }}
      title={t('connections.sendTitle', { model: sending?.model ?? '' })}
      description={t('connections.sendBody')}
      confirmLabel={t('connections.sendConfirm')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => { if (sending) void test(sending, sending.model); setSending(null); }}
    />
  </div>;
}

function Section({ icon, title, action, loading, empty, children }: { icon: ReactNode; title: string; action?: ReactNode; loading: boolean; empty: ReactNode; children: ReactNode }) {
  return <Card>
    <CardHeader className="grid-rows-[auto] items-center">
      <h2 className="panel-title">{icon}{title}</h2>
      {action ? <CardAction className="row-span-1 self-center">{action}</CardAction> : null}
    </CardHeader>
    <CardContent className="grid gap-3">
      {loading ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : children ?? empty}
    </CardContent>
  </Card>;
}

type StatusOf = (target: ConnectionTarget) => ReactNode;
type ControlsOf = (named: Named) => ReactNode;

/** Keys grouped under their provider, in the order SillyTavern lists them. */
function KeyGroups({ t, keys, profileNames, status, controls }: { t: Translate; keys: readonly ConnectionKey[]; profileNames: ReadonlyMap<string, string>; status: StatusOf; controls: ControlsOf }) {
  const groups = new Map<string, ConnectionKey[]>();
  for (const key of keys) groups.set(key.secretKey, [...groups.get(key.secretKey) ?? [], key]);
  return <div className="grid gap-4">
    {[...groups.values()].map((group) => {
      const provider = connectionProviderName(group[0]?.provider ?? '');
      return <section key={group[0]?.secretKey} className="grid gap-1" aria-label={provider}>
        <h3 className="text-sm font-medium">{provider}</h3>
        <ul className="grid divide-y rounded-lg border px-3">
          {group.map((key) => {
            const target: ConnectionTarget = { kind: 'key', secretKey: key.secretKey, id: key.id };
            return <Row key={key.id ?? key.secretKey} controls={controls({ target, name: t('connections.keyName', { label: key.label, provider }) })}>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium break-all">{key.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{key.masked}</span>
                {key.active ? <Badge variant="secondary" title={t('connections.keyActiveHint')}>{t('connections.keyActive')}</Badge> : null}
              </span>
              {status(target)}
              <UsedBy t={t} ids={key.profiles} profileNames={profileNames} />
            </Row>;
          })}
        </ul>
      </section>;
    })}
  </div>;
}

function ProxyRow({ t, proxy, profileNames, status, controls }: { t: Translate; proxy: ConnectionProxy; profileNames: ReadonlyMap<string, string>; status: ReactNode; controls: ReactNode }) {
  return <Row controls={controls} edge>
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium break-all">{proxy.name}</span>
      {proxy.selected ? <Badge variant="secondary">{t('connections.proxySelected')}</Badge> : null}
      {proxy.hasPassword ? <Badge variant="outline">{t('connections.proxyHasPassword')}</Badge> : null}
    </span>
    <span className="font-mono text-xs break-all text-muted-foreground">{proxy.url ?? t('connections.noAddress')}</span>
    {status}
    <UsedBy t={t} ids={proxy.profiles} profileNames={profileNames} />
  </Row>;
}

function ProfileRow({ t, profile, status, controls }: { t: Translate; profile: ConnectionProfile; status: ReactNode; controls: ReactNode }) {
  const parts = [
    profile.api ? connectionProviderName(connectionApiProvider(profile.api)) : null,
    profile.model,
    profile.proxy ? t('connections.profileProxy', { name: profile.proxy }) : null,
    profile.secretLabel ? t('connections.profileKey', { label: profile.secretLabel }) : null,
  ].filter((part): part is string => Boolean(part));
  return <Row controls={controls} edge>
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium break-all">{profile.name}</span>
      {profile.selected ? <Badge variant="secondary">{t('connections.profileSelected')}</Badge> : null}
      <Badge variant="outline">{t(profile.mode === 'tc' ? 'connections.modeText' : 'connections.modeChat')}</Badge>
      {profile.secretId && !profile.secretLabel ? <Badge variant="destructive" title={t('connections.profileKeyMissingHint')}>{t('connections.profileKeyMissing')}</Badge> : null}
    </span>
    <span className="text-sm break-all text-muted-foreground">{parts.length > 0 ? parts.join(' · ') : t('connections.profileEmpty')}</span>
    {profile.apiUrl ? <span className="font-mono text-xs break-all text-muted-foreground">{profile.apiUrl}</span> : null}
    {status}
  </Row>;
}

/** One row: what it is on the left, its buttons on the right. */
function Row({ children, controls, edge = false }: { children: ReactNode; controls: ReactNode; edge?: boolean }) {
  return <li className={`flex items-start justify-between gap-2 py-2.5${edge ? ' first:pt-0 last:pb-0' : ''}`}>
    <span className="grid min-w-0 flex-1 gap-1">{children}</span>
    <span className="flex shrink-0 items-center gap-1">{controls}</span>
  </li>;
}

function UsedBy({ t, ids, profileNames }: { t: Translate; ids: readonly string[]; profileNames: ReadonlyMap<string, string> }) {
  if (ids.length === 0) return null;
  return <span className="text-xs break-all text-muted-foreground">{t('connections.usedBy', { names: ids.map((id) => profileNames.get(id) ?? id).join(', ') })}</span>;
}

function TestControls({ t, named, result, busy, canAct, onTest, onModels, onSend }: { t: Translate; named: Named; result: ConnectionTestResult | null; busy: boolean; canAct: boolean; onTest: () => void; onModels: () => void; onSend: (() => void) | undefined }) {
  const hasModels = (result?.modelCount ?? 0) > 0;
  return <>
    <Button variant="outline" size="sm" disabled={busy || !canAct} onClick={onTest} aria-label={t('connections.testNamed', { name: named.name })}>
      {busy ? <LoaderCircle className="animate-spin" /> : <Activity />}<span className="max-sm:sr-only">{t('connections.test')}</span>
    </Button>
    {hasModels || onSend ? <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('connections.rowMenu', { name: named.name })} disabled={busy}><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {hasModels ? <DropdownMenuItem onSelect={onModels}><List />{t('connections.modelsButton')}</DropdownMenuItem> : null}
        {onSend ? <DropdownMenuItem onSelect={onSend} disabled={!canAct}><Send />{t('connections.sendTest')}</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu> : null}
  </>;
}

/** The last test's result: a chip, and the numbers that came with it. */
function TestStatus({ t, locale, result, money }: { t: Translate; locale: LocaleCode; result: ConnectionTestResult | null; money: (amount: number, currency: string) => string }) {
  if (!result) return <span><Badge variant="outline" className="text-muted-foreground">{t('connections.untested')}</Badge></span>;
  const when = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(result.testedAt));
  const details = [
    result.balance ? t('connections.balance', { amount: money(result.balance.amount, result.balance.currency) }) : null,
    result.modelCount !== null ? t('connections.modelCount', { count: result.modelCount }) : null,
    result.latencyMs !== null && result.code === 'ok' ? t('connections.latency', { ms: result.latencyMs }) : null,
    result.via === 'sillytavern' ? t('connections.viaSillyTavern') : null,
    t('connections.testedAt', { when }),
  ].filter((part): part is string => Boolean(part));
  return <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    <Badge variant={chipVariant(result)} className={chipClass(result)} title={t(`connections.codeHints.${result.code}` as MessageKey)}>{t(`connections.codes.${result.code}` as MessageKey)}</Badge>
    <span className="text-xs text-muted-foreground">{details.join(' · ')}</span>
  </span>;
}

function chipVariant(result: ConnectionTestResult): 'secondary' | 'outline' | 'destructive' {
  if (result.code === 'ok') return 'secondary';
  if (result.code === 'needs_sillytavern' || result.code === 'unsupported' || result.code === 'rate_limited') return 'outline';
  return 'destructive';
}

function chipClass(result: ConnectionTestResult): string | undefined {
  return result.code === 'ok' ? 'bg-(--success-background) text-(--success)' : undefined;
}

/** What a test says in a toast: the plain sentence the plan promised, in both languages. */
function resultToast(t: Translate, name: string, result: ConnectionTestResult, money: (amount: number, currency: string) => string, model: string | null): { title: string; tone: 'success' | 'destructive' } {
  if (result.code !== 'ok') return { title: t('connections.toastFailed', { name, reason: t(`connections.codeHints.${result.code}` as MessageKey) }), tone: 'destructive' };
  if (model && result.sent) return { title: t('connections.sentOk', { model }), tone: 'success' };
  if (result.balance) return { title: t('connections.toastBalance', { name, amount: money(result.balance.amount, result.balance.currency) }), tone: 'success' };
  return { title: t('connections.toastOk', { name, count: result.modelCount ?? 0 }), tone: 'success' };
}

/** The models a target's last test brought back, searchable. */
function ModelsSheet({ t, named, onClose, onSend, canSend }: { t: Translate; named: Named | null; onClose: () => void; onSend: (model: string) => void; canSend: boolean }) {
  const [list, setList] = useState<ConnectionModelList | null>(null);
  const [missing, setMissing] = useState(false);
  const [search, setSearch] = useState('');
  useEffect(() => {
    setList(null); setMissing(false); setSearch('');
    if (!named) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ kind: named.target.kind });
    if (named.target.kind === 'key') { params.set('secretKey', named.target.secretKey); if (named.target.id !== null) params.set('id', named.target.id); }
    if (named.target.kind === 'proxy') params.set('name', named.target.name);
    if (named.target.kind === 'profile') params.set('id', named.target.id);
    void (async () => {
      try {
        const response = await apiFetch(`/api/v1/connections/models?${params.toString()}`, { credentials: 'same-origin', signal: controller.signal });
        if (response.ok) setList(await response.json() as ConnectionModelList);
        else setMissing(true);
      } catch { /* closing and opening asks again */ }
    })();
    return () => controller.abort();
  }, [named]);
  const matches = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    return (list?.models ?? []).filter((model) => words.every((word) => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(word)));
  }, [list, search]);
  const price = (value: number | null) => value === null ? '?' : `$${value < 1 ? value.toFixed(3).replace(/0+$/u, '') : value.toFixed(2)}`;
  return <Sheet open={named !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>{t('connections.modelsTitle', { name: named?.name ?? '' })}</SheetTitle>
        <SheetDescription>{list ? t('connections.modelCount', { count: list.models.length }) : t('connections.modelsDescription')}</SheetDescription>
      </SheetHeader>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 pb-4">
        {missing ? <p className="text-sm text-muted-foreground">{t('connections.modelsExpired')}</p>
          : list === null ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            : <>
              <Input type="search" autoComplete="off" spellCheck={false} placeholder={t('connections.modelsSearch')} value={search} onChange={(event) => setSearch(event.target.value)} />
              {matches.length === 0 ? <p className="text-sm text-muted-foreground">{t('connections.modelsEmpty')}</p> : null}
              <ul className="grid divide-y">
                {matches.slice(0, MODELS_SHOWN).map((model: ConnectionModel) => <li key={model.id} className="flex items-start justify-between gap-2 py-2">
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-mono text-xs break-all">{model.id}</span>
                    {model.name ? <span className="text-xs break-all text-muted-foreground">{model.name}</span> : null}
                    {model.contextLength !== null || model.promptPrice !== null ? <span className="text-xs text-muted-foreground">{[
                      model.contextLength !== null ? t('connections.contextLength', { tokens: model.contextLength.toLocaleString() }) : null,
                      model.promptPrice !== null || model.completionPrice !== null ? t('connections.price', { prompt: price(model.promptPrice), completion: price(model.completionPrice) }) : null,
                    ].filter(Boolean).join(' · ')}</span> : null}
                  </span>
                  <Button variant="ghost" size="icon-sm" disabled={!canSend} aria-label={t('connections.sendTestModel', { model: model.id })} title={t('connections.sendTest')} onClick={() => onSend(model.id)}><Send /></Button>
                </li>)}
              </ul>
              {matches.length > MODELS_SHOWN ? <p className="text-xs text-muted-foreground">{t('connections.modelsMore', { count: matches.length - MODELS_SHOWN })}</p> : null}
            </>}
      </div>
    </SheetContent>
  </Sheet>;
}
