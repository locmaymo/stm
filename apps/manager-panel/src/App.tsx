import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Archive, ArrowUpRight, BarChart3, Code2, Copy, Database, Download,
  Globe2, LayoutDashboard, Maximize2, Minimize2, Moon, Package, Plus,
  ScrollText, Search, Sun, Upload, Users as UsersIcon, X, Rows3,
} from 'lucide-react';
import {
  Badge, Button, Card, CardAction, CardContent, CardFooter, CardHeader,
  Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarTrigger, Sheet, SheetContent, SheetHeader, SheetTitle, Switch, Tooltip,
  TooltipContent, TooltipTrigger, useSidebar,
} from '../../../packages/ui/src/index.js';
import { translator, type Translate } from './i18n.js';
import { browserStorage, readPreferences, savePreferences, type Preferences } from './preferences.js';
import type { Installation, LogEntry, LogSourceFilter, ProcessState, Profile, ProfileLayout, TunnelState, VersionOption } from '../../../packages/contracts/src/index.js';
import { useLiveLogs } from './use-live-logs.js';
import { formatLogMessage } from './log-format.js';

const navigation = [
  { id: 'overview', icon: LayoutDashboard },
  { id: 'data', icon: Database }, { id: 'metrics', icon: BarChart3 },
  { id: 'config', icon: Code2 },
] as const;
type PageId = typeof navigation[number]['id'];
type Navigate = (page: PageId) => void;

function pageFromHash(): PageId {
  const hash = window.location.hash.slice(1);
  return navigation.find(({ id }) => id === hash)?.id ?? 'overview';
}

export function App() {
  return <AuthGate />;
}

function AuthGate() {
  const [mode, setMode] = useState<'checking' | 'setup' | 'login' | 'ready'>('checking');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [setupCodeRequired, setSetupCodeRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = translator(readPreferences(browserStorage()).locale);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/v1/setup/status', { credentials: 'same-origin' }).then(async (response) => response.json() as Promise<{ setupRequired: boolean; setupCodeRequired: boolean }>).then(async (status) => {
      if (cancelled) return;
      setSetupCodeRequired(status.setupCodeRequired);
      if (status.setupRequired) { setMode('setup'); return; }
      const response = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
      if (!response.ok) { if (!cancelled) setMode('login'); return; }
      const payload = await response.json() as { session: { csrfToken: string } };
      if (!cancelled) { setCsrfToken(payload.session.csrfToken); setMode('ready'); }
    }).catch(() => { if (!cancelled) { setError(t('setup.connectionError')); setMode('login'); } });
    return () => { cancelled = true; };
  }, []);
  if (mode === 'ready' && csrfToken) return <ConsoleApp csrfToken={csrfToken} />;
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(mode === 'setup' ? '/api/v1/setup/password' : '/api/v1/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'setup' ? { password, setupCode, termsAccepted: accepted, telemetryAccepted: accepted } : { password }),
      });
      const payload = await response.json() as { session?: { csrfToken: string }; error?: { message: string } };
      if (!response.ok || !payload.session) { setError(payload.error?.message ?? t('setup.authError')); return; }
      setCsrfToken(payload.session.csrfToken); setMode('ready');
    } catch { setError(t('setup.connectionError')); } finally { setBusy(false); }
  };
  return <div className="auth-shell"><Card className="w-full max-w-md"><CardHeader><h1 className="text-xl font-semibold">{mode === 'setup' ? t('setup.title') : t('setup.loginTitle')}</h1></CardHeader><CardContent><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}><div><label className="field-label" htmlFor="admin-password">{t('setup.password')}</label><Input id="admin-password" type="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></div>{mode === 'setup' && setupCodeRequired ? <div><label className="field-label" htmlFor="setup-code">{t('setup.setupCode')}</label><Input id="setup-code" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} required /></div> : null}{mode === 'setup' ? <><p className="text-sm text-muted-foreground">{t('setup.telemetryNotice')}</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} required className="mt-1" /><span>{t('setup.terms')}</span></label></> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<Button type="submit" className="w-full" disabled={busy || mode === 'checking' || (mode === 'setup' && !accepted)}>{busy || mode === 'checking' ? t('common.loading') : mode === 'setup' ? t('setup.createAdmin') : t('setup.signIn')}</Button></form></CardContent></Card></div>;
}

function ConsoleApp({ csrfToken }: { csrfToken: string }) {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [preferences, setPreferences] = useState(() => readPreferences(browserStorage()));
  const [version, setVersion] = useState('latest');
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [activeInstallationId, setActiveInstallationId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [pendingInstallationId, setPendingInstallationId] = useState<string | null>(null);
  const [logSource, setLogSource] = useState<LogSourceFilter>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [compactLogs, setCompactLogs] = useState(false);
  const [processState, setProcessState] = useState<ProcessState>({ status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null });
  const [tunnelState, setTunnelState] = useState<TunnelState>({ mode: 'off', status: 'stopped', url: null, startedAt: null, error: null });
  const t = translator(preferences.locale);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const applyMobileDefault = () => { if (media.matches) setCompactLogs(true); };
    applyMobileDefault();
    media.addEventListener('change', applyMobileDefault);
    return () => media.removeEventListener('change', applyMobileDefault);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [processResponse, tunnelResponse] = await Promise.all([
        fetch('/api/v1/process', { credentials: 'same-origin' }),
        fetch('/api/v1/tunnel', { credentials: 'same-origin' }),
      ]);
      if (cancelled) return;
      if (processResponse.ok) setProcessState(await processResponse.json() as ProcessState);
      if (tunnelResponse.ok) setTunnelState(await tunnelResponse.json() as TunnelState);
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', preferences.theme === 'dark');
    document.documentElement.lang = preferences.locale;
    document.documentElement.dataset.theme = preferences.theme;
    savePreferences(preferences, browserStorage());
  }, [preferences]);

  useEffect(() => {
    const onHashChange = () => {
      const next = pageFromHash();
      const hash = window.location.hash.slice(1);
      if (hash && hash !== next) window.history.replaceState(null, '', `#${next}`);
      setPage(next);
    };
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch('/api/v1/versions', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ versions: VersionOption[] }> : null),
      fetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null),
      fetch('/api/v1/profiles', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ profiles: Profile[]; activeProfileId: string | null }> : null),
    ]).then(([versionPayload, installationPayload, profilePayload]) => {
      if (cancelled) return;
      if (versionPayload) setVersions(versionPayload.versions);
      if (installationPayload) { setInstallations(installationPayload.installations); setActiveInstallationId(installationPayload.activeInstallationId); }
      if (profilePayload) { setProfiles(profilePayload.profiles); setActiveProfileId(profilePayload.activeProfileId); }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!installing) return undefined;
    if (!pendingInstallationId) return undefined;
    const timer = window.setInterval(() => {
      void fetch(`/api/v1/installations/${pendingInstallationId}`, { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<Installation> : null).then((installation) => {
        if (!installation) return;
        setInstallations((current) => [...current.filter((item) => item.id !== installation.id), installation]);
        if (installation.status === 'ready' || installation.status === 'failed') {
          setInstalling(false);
          // Keep the pending id so the just-finished result stays visible.
          // Refresh the active pointer after the runtime switches atomically.
          void fetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null).then((payload) => {
            if (!payload) return;
            setInstallations(payload.installations);
            setActiveInstallationId(payload.activeInstallationId);
          }).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [installing, pendingInstallationId]);

  const navigate: Navigate = (next) => { window.location.hash = next; setPage(next); window.scrollTo({ top: 0 }); };
  const changePreferences = (update: Partial<Preferences>) => setPreferences((current) => ({ ...current, ...update }));
  const logEntries = useLiveLogs(logSource);
  const installation = <InstallationPanel t={t} version={version} onVersionChange={setVersion} versions={versions} installations={installations} activeInstallationId={activeInstallationId} pendingInstallationId={pendingInstallationId} onPendingInstallationId={setPendingInstallationId} csrfToken={csrfToken} installing={installing} onInstalling={setInstalling} />;
  const logs = <LogsPanel t={t} source={logSource} onSourceChange={setLogSource} entries={logEntries} query={logQuery} onQueryChange={setLogQuery} compact={compactLogs} onToggleCompact={() => setCompactLogs((current) => !current)} expanded={logsExpanded} onToggleExpanded={() => setLogsExpanded((current) => !current)} />;
  const updateRuntime = async (path: string, body?: unknown) => {
    const init: RequestInit = { method: body === undefined ? 'POST' : 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(path, init);
    if (response.ok) {
      const payload = await response.json() as ProcessState | TunnelState;
      if (path.includes('/process')) setProcessState(payload as ProcessState); else setTunnelState(payload as TunnelState);
    }
  };

  return (
    <SidebarProvider style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.75rem' } as CSSProperties}>
      <AppSidebar page={page} navigate={navigate} t={t} />
      <SidebarInset className="min-w-0">
        <header className="site-header">
          <SidebarTrigger label={t('console.toggleNavigation')} className="size-10 shrink-0" />
          <h1>{t(`nav.${page}`)}</h1>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {page === 'overview' ? <Button variant="outline" size="sm" className="log-header-button" onClick={() => setLogsExpanded(true)}><ScrollText />{t('console.openLogs')}</Button> : null}
            <LanguageControl t={t} preferences={preferences} onChange={changePreferences} />
            <Button variant="ghost" size="icon" className="size-10" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => changePreferences({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
              {preferences.theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <div className="page-body">
          {page === 'overview' ? <div className="core-grid">{installation}<AccessPanel t={t} process={processState} tunnel={tunnelState} installed={Boolean(activeInstallationId)} onAction={updateRuntime} /> <DataPanel t={t} navigate={navigate} activeProfile={profiles.find((profile) => profile.id === activeProfileId) ?? null} />{logs}</div> : page === 'data' ? <DataPage t={t} csrfToken={csrfToken} profiles={profiles} activeProfileId={activeProfileId} onProfilesChange={(next, active) => { setProfiles(next); setActiveProfileId(active); }} /> : <ResourcePanel page={page} t={t} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebar({ page, navigate, t }: { page: PageId; navigate: Navigate; t: Translate }) {
  const { setOpenMobile, isMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon" mobileTitle={t('console.navigation')}>
      <SidebarHeader className="brand-header">
        <a href="#overview" aria-label="SillyTavern Manager" className="brand" onClick={() => setOpenMobile(false)}><span className="brand-symbol" aria-hidden="true">ST</span><span className="truncate group-data-[collapsible=icon]:hidden">ST Manager</span></a>
        {isMobile ? <Button variant="ghost" size="icon" className="ml-auto shrink-0" aria-label={t('console.closeNavigation')} onClick={() => setOpenMobile(false)}><X /></Button> : null}
      </SidebarHeader>
      <SidebarContent><SidebarGroup><SidebarGroupContent><nav aria-label={t('console.navigation')}><SidebarMenu>{navigation.map(({ id, icon: Icon }) => <SidebarMenuItem key={id}><SidebarMenuButton asChild isActive={page === id} tooltip={t(`nav.${id}`)} className="h-11 gap-3 px-3 text-sm md:h-10 group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:p-3!"><a href={`#${id}`} aria-current={page === id ? 'page' : undefined} aria-label={t(`nav.${id}`)} onClick={() => { navigate(id); setOpenMobile(false); }}><Icon className="size-4" /><span>{t(`nav.${id}`)}</span></a></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></nav></SidebarGroupContent></SidebarGroup></SidebarContent>
    </Sidebar>
  );
}

function LanguageControl({ t, preferences, onChange }: { t: Translate; preferences: Preferences; onChange: (value: Partial<Preferences>) => void }) {
  return <div className="language-control" role="group" aria-label={t('dashboard.language')}>{(['en', 'vi'] as const).map((locale) => <button key={locale} type="button" aria-pressed={preferences.locale === locale} onClick={() => onChange({ locale })}>{locale.toUpperCase()}</button>)}</div>;
}

function PanelHeading({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <CardHeader><h2 className="panel-title">{icon}{children}</h2>{action ? <CardAction>{action}</CardAction> : null}</CardHeader>;
}

function Unavailable({ t, children }: { t: Translate; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md" aria-label={t('console.unavailable')}>{children}</span></TooltipTrigger><TooltipContent>{t('console.unavailable')}</TooltipContent></Tooltip>;
}

function InstallationPanel({ t, version, onVersionChange, versions, installations, activeInstallationId, pendingInstallationId, onPendingInstallationId, csrfToken, installing, onInstalling }: { t: Translate; version: string; onVersionChange: (value: string) => void; versions: VersionOption[]; installations: Installation[]; activeInstallationId: string | null; pendingInstallationId: string | null; onPendingInstallationId: (value: string | null) => void; csrfToken: string | null; installing: boolean; onInstalling: (value: boolean) => void }) {
  const [requestError, setRequestError] = useState<string | null>(null);
  const active = installations.find((item) => item.id === pendingInstallationId) ?? installations.find((item) => item.id === activeInstallationId) ?? installations.at(-1);
  const status = active?.status === 'ready' ? t('dashboard.ready') : active?.status === 'failed' ? t('dashboard.installFailed') : active ? `${active.step} · ${Math.round(active.progress)}%` : t('dashboard.notInstalled');
  const canInstall = Boolean(csrfToken) && !installing;
  const install = async () => {
    if (!csrfToken) return;
    setRequestError(null);
    onInstalling(true);
    try {
      const response = await fetch('/api/v1/installations', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ version }) });
      const payload = await response.json() as { installationId?: string; error?: { message?: string } };
      if (!response.ok) { setRequestError(payload.error?.message ?? t('console.installRequestFailed')); onInstalling(false); return; }
      if (!payload.installationId) { setRequestError(t('console.installRequestFailed')); onInstalling(false); return; }
      onPendingInstallationId(payload.installationId);
    } catch { setRequestError(t('console.installRequestFailed')); onInstalling(false); }
  };
  const choices = versions.length > 0 ? versions : [{ selector: 'latest', label: `${t('dashboard.latest')} (latest)`, ref: 'latest', channel: 'release', tag: null, publishedAt: null }, { selector: 'release', label: 'release', ref: 'release', channel: 'release', tag: null, publishedAt: null }, { selector: 'staging', label: 'staging', ref: 'staging', channel: 'staging', tag: null, publishedAt: null }] satisfies VersionOption[];
  return <Card data-tour="installation"><PanelHeading icon={<Package />} action={<Badge variant="outline" className={active?.status === 'ready' ? '' : 'status-attention'}>{status}</Badge>}>SillyTavern</PanelHeading><CardContent className="flex-1"><label className="field-label" htmlFor="install-version">{t('dashboard.version')}</label><Select value={version} onValueChange={onVersionChange}><SelectTrigger id="install-version" className="w-full"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start" className="version-select-content">{choices.map((choice) => <SelectItem key={choice.selector} value={choice.selector}>{choice.label}</SelectItem>)}</SelectContent></Select>{active && active.status !== 'ready' && active.status !== 'failed' ? <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${active.progress}%` }} /></div> : null}{active?.status === 'ready' ? <p className="install-result">{t('console.installComplete')} · {active.resolvedRef}</p> : null}{active?.status === 'failed' && active.error ? <p className="install-error" role="alert">{active.error}</p> : null}{requestError ? <p className="install-error" role="alert">{requestError}</p> : null}</CardContent><CardFooter>{canInstall ? <Button onClick={() => void install()}><Download />{installing ? t('common.loading') : t('dashboard.install')}</Button> : <Unavailable t={t}><Button disabled><Download />{t('dashboard.install')}</Button></Unavailable>}</CardFooter></Card>;
}

function AccessPanel({ t, process, tunnel, installed, onAction }: { t: Translate; process: ProcessState; tunnel: TunnelState; installed: boolean; onAction: (path: string, body?: unknown) => Promise<void> }) {
  const running = process.status === 'running';
  const tunnelRunning = tunnel.status === 'running' || tunnel.status === 'starting';
  const processLabel = process.status === 'running' ? t('dashboard.running') : process.status === 'starting' || process.status === 'stopping' ? t('common.loading') : process.status === 'error' ? t('dashboard.installFailed') : t('dashboard.offline');
  const toggleTunnel = () => void onAction('/api/v1/tunnel', { mode: tunnelRunning ? 'off' : 'quick' });
  const openLocal = () => { window.open('http://127.0.0.1:8000', '_blank', 'noopener,noreferrer'); };
  const copyTunnel = async () => { if (tunnel.url) await navigator.clipboard?.writeText(tunnel.url); };
  return <Card data-tour="public-access"><PanelHeading icon={<Globe2 />} action={<Badge variant="secondary" className={running ? 'status-online' : tunnel.error ? 'status-attention' : ''}>{processLabel}</Badge>}>{t('console.publicAccess')}</PanelHeading><CardContent className="flex-1 space-y-4"><div className="flex items-center justify-between gap-4"><label htmlFor="tunnel-switch" className="text-sm">Cloudflare Quick Tunnel</label><Switch id="tunnel-switch" checked={tunnelRunning} onCheckedChange={toggleTunnel} disabled={!installed || !running || tunnel.status === 'starting'} aria-label={t('console.enableTunnel')} /></div><dl className="address-list"><div><dt>{t('console.local')}</dt><dd><code>127.0.0.1:8000</code></dd></div><div><dt>{t('dashboard.publicAddress')}</dt><dd>{tunnel.url ? <code>{tunnel.url}</code> : '—'}</dd></div></dl>{process.error ? <p className="install-error" role="alert">{process.error}</p> : null}{tunnel.error ? <p className="install-error" role="alert">{tunnel.error}</p> : null}</CardContent><CardFooter className="gap-2"><Button variant="outline" onClick={openLocal} disabled={!running}><ArrowUpRight />{t('dashboard.open')}</Button><Button variant="ghost" onClick={() => void copyTunnel()} disabled={!tunnel.url}><Copy />{t('dashboard.copyLink')}</Button><Button variant="ghost" onClick={() => void onAction(running ? '/api/v1/process/stop' : '/api/v1/process/start')} disabled={!installed || process.status === 'starting' || process.status === 'stopping'}>{running ? t('dashboard.stop') : t('dashboard.start')}</Button></CardFooter></Card>;
}

function DataPanel({ t, navigate, activeProfile }: { t: Translate; navigate: Navigate; activeProfile: Profile | null }) {
  return <Card data-tour="data"><PanelHeading icon={<Database />}>{t('console.data')}</PanelHeading><CardContent className="flex-1 space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-muted-foreground">{activeProfile?.name ?? t('console.noProfiles')}</span><Button variant="ghost" size="sm" onClick={() => navigate('data')}>{t('nav.data')}<ArrowUpRight /></Button></div>{activeProfile ? <dl className="address-list"><div><dt>{t('console.layout')}</dt><dd>{activeProfile.layout === 'data' ? t('console.layoutData') : t('console.layoutPublic')}</dd></div></dl> : null}<dl className="address-list"><div><dt>{t('status.lastBackup')}</dt><dd>—</dd></div></dl></CardContent><CardFooter className="flex-wrap gap-2"><Button variant="outline" onClick={() => navigate('data')}><Archive />{t('nav.data')}</Button><Button variant="ghost" onClick={() => navigate('data')}><Upload />{t('console.restore')}</Button></CardFooter><div className="r2-note"><Tooltip><TooltipTrigger asChild><button type="button" onClick={() => navigate('data')}>{t('console.r2Recommended')}</button></TooltipTrigger><TooltipContent className="max-w-xs">{t('console.r2Help')}</TooltipContent></Tooltip></div></Card>;
}

function LogsPanel({ t, source, onSourceChange, entries, query, onQueryChange, compact, onToggleCompact, expanded, onToggleExpanded }: { t: Translate; source: LogSourceFilter; onSourceChange: (value: LogSourceFilter) => void; entries: LogEntry[]; query: string; onQueryChange: (value: string) => void; compact: boolean; onToggleCompact: () => void; expanded: boolean; onToggleExpanded: () => void }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = () => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; if (!expanded) onToggleExpanded(); };
  const close = () => { if (expanded) onToggleExpanded(); };
  const contentProps = { t, source, onSourceChange, entries, query, onQueryChange, compact, onToggleCompact };
  const cardContents = expanded ? <div className="log-card-placeholder" aria-hidden="true" /> : <LogsContent {...contentProps} />;
  return <><Card data-tour="logs" data-expanded={expanded}><PanelHeading icon={<ScrollText />} action={<Button variant="ghost" size="sm" onClick={open} aria-label={t('console.expandLogs')}><Maximize2 />{t('console.expandLogs')}</Button>}>{t('console.liveLogs')}</PanelHeading>{cardContents}</Card><Sheet open={expanded} onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}><SheetContent side="bottom" className="log-sheet" showCloseButton={false} onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus.current?.focus({ preventScroll: true }); }}><SheetHeader className="log-sheet-header"><SheetTitle>{t('console.liveLogs')}</SheetTitle><Button variant="ghost" size="sm" onClick={close}><Minimize2 />{t('console.collapseLogs')}</Button></SheetHeader><LogsContent {...contentProps} expanded /></SheetContent></Sheet></>;
}

function LogsContent({ t, source, onSourceChange, entries, query, onQueryChange, compact, onToggleCompact, expanded = false }: { t: Translate; source: LogSourceFilter; onSourceChange: (value: LogSourceFilter) => void; entries: LogEntry[]; query: string; onQueryChange: (value: string) => void; compact: boolean; onToggleCompact: () => void; expanded?: boolean }) {
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = normalizedQuery.length === 0 ? entries : entries.filter((entry) => `${entry.source} ${entry.message}`.toLocaleLowerCase().includes(normalizedQuery));
  const showSource = source === 'all';
  const latestVisibleId = visibleEntries.at(-1)?.id;
  useEffect(() => {
    const element = logViewportRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [latestVisibleId, visibleEntries.length, normalizedQuery, source, compact]);
  return <div className={`logs-content ${expanded ? 'logs-content-expanded' : ''}`}>
    <div className="log-toolbar">
      <Select value={source} onValueChange={(value) => onSourceChange(value as LogSourceFilter)}>
        <SelectTrigger className="w-44" aria-label={t('console.logSource')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('console.allLogs')}</SelectItem>
          <SelectItem value="sillytavern">SillyTavern</SelectItem>
          <SelectItem value="manager">Manager</SelectItem>
          <SelectItem value="cloudflared">Cloudflare Tunnel</SelectItem>
          <SelectItem value="installer">{t('console.installer')}</SelectItem>
          <SelectItem value="backup">{t('nav.backups')}</SelectItem>
        </SelectContent>
      </Select>
      <div className="log-search"><Search aria-hidden="true" /><Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t('console.searchLogs')} aria-label={t('console.searchLogs')} /></div>
      <Button type="button" variant="outline" size="sm" className="log-density-toggle" onClick={onToggleCompact} aria-pressed={compact} aria-label={compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}><Rows3 />{compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}</Button>
    </div>
    <div className="log-view" ref={logViewportRef} role="log" tabIndex={0} aria-label={t('console.liveLogs')}>
      {visibleEntries.length === 0 ? <span className="log-empty">{normalizedQuery ? t('console.noLogMatches') : t('console.noLogs')}</span> : <div className="log-lines">
        {visibleEntries.map((entry) => <div className="log-line" key={entry.id}>
          {compact ? null : <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false })}</time>}
          {showSource ? <span className="log-source">{entry.source}</span> : null}
          <span className="log-message">{formatLogMessage(entry.message)}</span>
        </div>)}
      </div>}
    </div>
  </div>;
}

function DataPage({ t, csrfToken, profiles, activeProfileId, onProfilesChange }: { t: Translate; csrfToken: string; profiles: Profile[]; activeProfileId: string | null; onProfilesChange: (profiles: Profile[], activeProfileId: string | null) => void }) {
  const [name, setName] = useState('');
  const [layout, setLayout] = useState<ProfileLayout>('data');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    const response = await fetch('/api/v1/profiles', { credentials: 'same-origin' });
    if (!response.ok) return;
    const payload = await response.json() as { profiles: Profile[]; activeProfileId: string | null };
    onProfilesChange(payload.profiles, payload.activeProfileId);
  };
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/v1/profiles', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name, layout }) });
      if (!response.ok) { const payload = await response.json() as { error?: { message?: string } }; setError(payload.error?.message ?? t('console.profileCreateFailed')); return; }
      setName(''); await refresh();
    } catch { setError(t('console.profileCreateFailed')); } finally { setBusy(false); }
  };
  const activate = async (id: string) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v1/profiles/${id}/activate`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { const payload = await response.json() as { error?: { message?: string } }; setError(payload.error?.message ?? t('console.profileActivateFailed')); return; }
      await refresh();
    } catch { setError(t('console.profileActivateFailed')); } finally { setBusy(false); }
  };
  return <div className="data-stack"><Card><PanelHeading icon={<UsersIcon />} action={<Badge variant="outline">{profiles.length}</Badge>}>{t('nav.profiles')}</PanelHeading><CardContent className="space-y-4"><div className="profile-create"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('console.profileName')} aria-label={t('console.profileName')} /><Select value={layout} onValueChange={(value) => setLayout(value as ProfileLayout)}><SelectTrigger aria-label={t('console.layout')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="data">{t('console.layoutData')}</SelectItem><SelectItem value="public">{t('console.layoutPublic')}</SelectItem></SelectContent></Select><Button onClick={() => void create()} disabled={busy || !name.trim()}><Plus />{t('console.createProfile')}</Button></div>{error ? <p className="install-error" role="alert">{error}</p> : null}{profiles.length === 0 ? <p className="resource-empty">{t('console.noProfiles')}</p> : <div className="profile-list">{profiles.map((profile) => <div className="profile-row" key={profile.id}><div className="min-w-0"><strong>{profile.name}</strong><span>{profile.layout === 'data' ? t('console.layoutData') : t('console.layoutPublic')}</span></div>{profile.id === activeProfileId ? <Badge>{t('console.activeProfile')}</Badge> : <Button variant="outline" size="sm" onClick={() => void activate(profile.id)} disabled={busy}>{t('console.activateProfile')}</Button>}</div>)}</div>}</CardContent></Card><Card><PanelHeading icon={<Archive />}>{t('nav.backups')}</PanelHeading><CardContent className="resource-empty"><p>{t('dashboard.noBackup')}</p><Unavailable t={t}><Button disabled><Upload />{t('console.importZip')}</Button></Unavailable></CardContent><CardFooter className="border-t pt-5 text-sm text-muted-foreground">{t('console.r2Recommended')}</CardFooter></Card></div>;
}

function ResourcePanel({ page, t }: { page: Exclude<PageId, 'overview' | 'data'>; t: Translate }) {
  const emptyMessage = { metrics: 'console.noMetrics', config: 'console.noConfiguration' } as const;
  return <Card><CardContent className="resource-empty"><p>{t(emptyMessage[page])}</p></CardContent></Card>;
}
