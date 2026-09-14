import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Archive, ArrowDown, ArrowUp, ArrowUpRight, BarChart3, Cloud, Copy, Database, Download,
  Globe2, LayoutDashboard, Maximize2, Minimize2, Moon, Package, Pencil, Plus,
  RotateCcw, ScrollText, Search, Sun, Trash2, Upload, Users as UsersIcon, X, Rows3,
  BrainCircuit, CircleStop, Clock3, Cpu, Ellipsis, Play, QrCode as QrCodeIcon, RefreshCw, Settings2, Square,
} from 'lucide-react';
import {
  Alert, AlertDescription, AuthLayout, Badge, BrandMark, Button, buttonVariants, Card, CardAction,
  ConfirmDialog, DetailRow, EmptyState, StatusHero, type StatusTone,
  CardContent, CardFooter, CardHeader,
  CardGrid, Checkbox, cn, DataTable, type DataTableColumn, type DataTableLabels,
  Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Field, initialQuery, Input, Label, MobileNav, PageContainer, PasswordInput,
  RadioGroup, RadioGroupItem,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarTrigger, Sheet, SheetContent, SheetHeader, SheetTitle, Switch,
  Tabs, TabsContent, TabsList, TabsTrigger, type TableQuery, Toaster, Tooltip,
  TooltipContent, TooltipTrigger, useSidebar, useToast,
} from '../../../packages/ui/src/index.js';
import { logCatalog, translator, type Translate } from './i18n.js';
import { browserEnvironment, browserStorage, readPreferences, savePreferences, type Preferences } from './preferences.js';
import { authErrorKey } from './auth-error.js';
import { apiFetch, onSessionExpired, resetSessionWatch } from './session.js';
import type { AccessGatewayState, BackupManifest, ConfigDocument, ConfigUpdateInput, Installation, Job, LogEntry, LogSourceFilter, MetricsSnapshot, ProcessState, Profile, R2Config, R2SnapshotSummary, RestoreMode, RestorePreview, SystemSnapshot, TunnelState, VersionOption } from '../../../packages/contracts/src/index.js';
import { backupSearchText, backupSortValue, formatBytes, snapshotSortValue } from '../../../packages/contracts/src/index.js';
import { useLiveLogs } from './use-live-logs.js';
import { translateLogEntry, translateStep } from './log-format.js';
import { QrCode } from './qr-code.js';

const navigation = [
  { id: 'overview', icon: LayoutDashboard },
  { id: 'data', icon: Database }, { id: 'metrics', icon: BarChart3 },
  { id: 'config', icon: Settings2 },
] as const;
type PageId = typeof navigation[number]['id'];
type Navigate = (page: PageId) => void;

function pageFromHash(): PageId {
  const hash = window.location.hash.slice(1);
  return navigation.find(({ id }) => id === hash)?.id ?? 'overview';
}

/** What the server's own `validatePassword` accepts, so the form agrees with it. */
const MIN_MANAGER_PASSWORD = 6;
/** The access gateway holds SillyTavern open to a network, and asks for more. */
const MIN_SILLY_PASSWORD = 8;

const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const UPLOAD_RETRIES = 3;
const UPLOAD_RATE_WINDOW_MS = 10_000;

function apiErrorFromText(text: string, status: number, fallback: string): string {
  try {
    const payload = JSON.parse(text) as { error?: { message?: string }; Message?: string };
    return payload.error?.message ?? payload.Message ?? `${fallback} (HTTP ${status})`;
  } catch {
    const looksLikeHtml = /<!doctype\s+html|<html[\s>]/iu.test(text);
    return looksLikeHtml
      ? `${fallback} (the Studio proxy returned an HTML error page; try again)`
      : `${fallback} (HTTP ${status})`;
  }
}

/** Thrown when the operator stops the work themselves, which is not an error. */
class StoppedError extends Error {
  public constructor() { super('stopped'); this.name = 'StoppedError'; }
}

async function uploadChunkWithRetry(url: string, body: Blob, headers: HeadersInit, signal?: AbortSignal): Promise<void> {
  let lastError = 'Upload request failed';
  for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt += 1) {
    if (signal?.aborted) throw new StoppedError();
    let response: Response;
    try {
      response = await apiFetch(url, { method: 'POST', credentials: 'same-origin', headers, body, ...(signal ? { signal } : {}) });
    } catch (error: unknown) {
      if (signal?.aborted) throw new StoppedError();
      lastError = error instanceof Error ? error.message : lastError;
      if (attempt === UPLOAD_RETRIES) throw new Error(lastError);
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 500 * (attempt + 1)));
      continue;
    }
    if (response.ok) return;
    const text = await response.text();
    lastError = apiErrorFromText(text, response.status, 'Upload request failed');
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === UPLOAD_RETRIES) throw new Error(lastError);
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 500 * (attempt + 1)));
  }
  throw new Error(lastError);
}

export function App() {
  return <AuthGate />;
}

type AuthMode = 'checking' | 'setup' | 'login' | 'ready';

/**
 * The screen in front of the console, and the one place that owns the session.
 *
 * It also owns the language and the theme. Both used to live inside the
 * console, which meant the first screen anyone sees - a password field, before
 * there is any session to read a preference with - was stuck in whatever
 * language the browser reported, with no way to change it until after signing
 * in. They are set here and handed down.
 */
function AuthGate() {
  const [mode, setMode] = useState<AuthMode>('checking');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [setupCodeRequired, setSetupCodeRequired] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [preferences, setPreferences] = useState(() => readPreferences(browserStorage(), browserEnvironment()));
  const t = translator(preferences.locale);
  const changePreferences = (update: Partial<Preferences>) => setPreferences((current) => ({ ...current, ...update }));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', preferences.theme === 'dark');
    document.documentElement.lang = preferences.locale;
    document.documentElement.dataset.theme = preferences.theme;
    savePreferences(preferences, browserStorage());
  }, [preferences]);

  // The console polls the runtime every second and a half. When the session
  // ends it has to be taken down, or those calls go on being refused with
  // nobody reading the refusal and nothing on screen saying why.
  useEffect(() => onSessionExpired(() => {
    setCsrfToken(null);
    setSignedOut(true);
    setMode('login');
  }), []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/v1/setup/status').then(async (response) => response.json() as Promise<{ setupRequired: boolean; setupCodeRequired: boolean }>).then(async (status) => {
      if (cancelled) return;
      setSetupCodeRequired(status.setupCodeRequired);
      if (status.setupRequired) { setMode('setup'); return; }
      // The session probe and the sign-in form are the calls where a refusal
      // is an ordinary answer rather than a session running out, so they go
      // straight to `fetch`. Routed through the watch, a first visit would be
      // met by a notice saying the reader had been signed out of something,
      // and a mistyped password would say the same.
      const response = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
      if (!response.ok) { if (!cancelled) setMode('login'); return; }
      const payload = await response.json() as { session: { csrfToken: string } };
      if (!cancelled) { setCsrfToken(payload.session.csrfToken); setMode('ready'); }
    }).catch(() => { if (!cancelled) setMode('login'); });
    return () => { cancelled = true; };
  }, []);

  const signedIn = (token: string) => {
    // Arm the watch again: the session that expired is not the session now held.
    resetSessionWatch();
    setSignedOut(false);
    setCsrfToken(token);
    setMode('ready');
  };

  if (mode === 'ready') {
    if (!csrfToken) return <div className="auth-shell" role="status" aria-busy="true" />;
    return <ConsoleApp csrfToken={csrfToken} preferences={preferences} onPreferencesChange={changePreferences} />;
  }
  // Until the session check answers there is nothing to ask for. Falling
  // through to the form showed a flash of the login screen on every reload of
  // an already signed-in console.
  if (mode === 'checking') return <div className="auth-shell" role="status" aria-busy="true" />;
  return (
    <AuthScreen
      t={t}
      mode={mode}
      setupCodeRequired={setupCodeRequired}
      signedOut={signedOut}
      preferences={preferences}
      onPreferencesChange={changePreferences}
      onSignedIn={signedIn}
    />
  );
}

function AuthScreen({ t, mode, setupCodeRequired, signedOut, preferences, onPreferencesChange, onSignedIn }: { t: Translate; mode: 'setup' | 'login'; setupCodeRequired: boolean; signedOut: boolean; preferences: Preferences; onPreferencesChange: (value: Partial<Preferences>) => void; onSignedIn: (csrfToken: string) => void }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = mode === 'setup';
  // Shown once the second field stops being a prefix of the first, rather than
  // the moment the two differ - a mismatch warning under a half-typed password
  // is noise that goes away on its own.
  const mismatch = setup && confirmPassword.length > 0 && !password.startsWith(confirmPassword);
  const ready = password.length >= MIN_MANAGER_PASSWORD
    && (!setup || (accepted && password === confirmPassword && (!setupCodeRequired || setupCode.length > 0)));

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      // Not `apiFetch`: see the note on the session probe above.
      const response = await fetch(setup ? '/api/v1/setup/password' : '/api/v1/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(setup ? { password, setupCode, termsAccepted: accepted, telemetryAccepted: accepted } : { password }),
      });
      const payload = await response.json() as { session?: { csrfToken: string }; error?: { code?: string; message?: string } };
      if (!response.ok || !payload.session) {
        const key = authErrorKey(payload.error?.code);
        setError(key ? t(key) : payload.error?.message ?? t('setup.authError'));
        return;
      }
      onSignedIn(payload.session.csrfToken);
    } catch { setError(t('setup.connectionError')); } finally { setBusy(false); }
  };

  return (
    <AuthLayout
      title={setup ? t('setup.title') : t('setup.loginTitle')}
      subtitle={setup ? t('setup.subtitle') : t('setup.loginSubtitle')}
      footer={setup ? t('setup.telemetryNotice') : null}
      controls={<>
        <LanguageControl t={t} preferences={preferences} onChange={onPreferencesChange} />
        <Button variant="ghost" size="icon-sm" className="size-9" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => onPreferencesChange({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
          {preferences.theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </>}
    >
      <Card>
        <CardContent className="pt-6">
          <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {signedOut ? <Alert><Clock3 /><AlertDescription>{t('setup.signedOut')}</AlertDescription></Alert> : null}
            <Field label={t('setup.password')} hint={setup ? t('setup.passwordHint') : null}>
              <PasswordInput
                revealLabel={t('setup.reveal')}
                hideLabel={t('setup.hide')}
                autoComplete={setup ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={MIN_MANAGER_PASSWORD}
                required
              />
            </Field>
            {setup ? (
              <Field label={t('console.confirmPassword')} error={mismatch ? t('setup.mismatch') : null}>
                <PasswordInput
                  revealLabel={t('setup.reveal')}
                  hideLabel={t('setup.hide')}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </Field>
            ) : null}
            {setup && setupCodeRequired ? (
              <Field label={t('setup.setupCode')} hint={t('setup.setupCodeHint')}>
                <Input value={setupCode} onChange={(event) => setSetupCode(event.target.value)} autoComplete="off" required />
              </Field>
            ) : null}
            {setup ? (
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox checked={accepted} onCheckedChange={(checked) => setAccepted(checked === true)} className="mt-0.5" />
                <span className="text-muted-foreground">{t('setup.terms')}</span>
              </label>
            ) : null}
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Button type="submit" size="lg" className="w-full" disabled={busy || !ready}>
              {busy ? t('common.loading') : setup ? t('setup.createAdmin') : t('setup.signIn')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

function ConsoleApp({ csrfToken, preferences, onPreferencesChange }: { csrfToken: string; preferences: Preferences; onPreferencesChange: (value: Partial<Preferences>) => void }) {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [version, setVersion] = useState('latest');
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [activeInstallationId, setActiveInstallationId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [installing, setInstalling] = useState(false);
  const [pendingInstallationId, setPendingInstallationId] = useState<string | null>(null);
  const [logSource, setLogSource] = useState<LogSourceFilter>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [compactLogs, setCompactLogs] = useState(false);
  const [processState, setProcessState] = useState<ProcessState>({ status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null });
  const [tunnelState, setTunnelState] = useState<TunnelState>({ mode: 'off', status: 'stopped', url: null, startedAt: null, error: null });
  const [configDocument, setConfigDocument] = useState<ConfigDocument | null>(null);
  const [accessSecurity, setAccessSecurity] = useState<AccessGatewayState>({ status: 'stopped', host: null, port: 8001, lan: false, passwordConfigured: false, error: null });
  const t = translator(preferences.locale);
  const catalog = logCatalog(preferences.locale);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const applyMobileDefault = () => { if (media.matches) setCompactLogs(true); };
    applyMobileDefault();
    media.addEventListener('change', applyMobileDefault);
    return () => media.removeEventListener('change', applyMobileDefault);
  }, []);

  useEffect(() => {
    if (!activeInstallationId) { setConfigDocument(null); return undefined; }
    let cancelled = false;
    const load = async () => {
      const response = await apiFetch('/api/v1/config', { credentials: 'same-origin' });
      if (response.ok && !cancelled) setConfigDocument(await response.json() as ConfigDocument);
    };
    void load();
    return () => { cancelled = true; };
  }, [activeInstallationId]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [processResponse, tunnelResponse, securityResponse] = await Promise.all([
        apiFetch('/api/v1/process', { credentials: 'same-origin' }),
        apiFetch('/api/v1/tunnel', { credentials: 'same-origin' }),
        apiFetch('/api/v1/access/security', { credentials: 'same-origin' }),
      ]);
      if (cancelled) return;
      if (processResponse.ok) setProcessState(await processResponse.json() as ProcessState);
      if (tunnelResponse.ok) setTunnelState(await tunnelResponse.json() as TunnelState);
      if (securityResponse.ok) setAccessSecurity(await securityResponse.json() as AccessGatewayState);
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

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
      apiFetch('/api/v1/versions', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ versions: VersionOption[] }> : null),
      apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null),
      apiFetch('/api/v1/profiles', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ profiles: Profile[]; activeProfileId: string | null }> : null),
      apiFetch('/api/v1/backups', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ backups: BackupManifest[] }> : null),
    ]).then(([versionPayload, installationPayload, profilePayload, backupPayload]) => {
      if (cancelled) return;
      if (versionPayload) setVersions(versionPayload.versions);
      if (installationPayload) { setInstallations(installationPayload.installations); setActiveInstallationId(installationPayload.activeInstallationId); }
      if (profilePayload) { setProfiles(profilePayload.profiles); setActiveProfileId(profilePayload.activeProfileId); }
      if (backupPayload) setBackups(backupPayload.backups);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!installing) return undefined;
    if (!pendingInstallationId) return undefined;
    const timer = window.setInterval(() => {
      void apiFetch(`/api/v1/installations/${pendingInstallationId}`, { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<Installation> : null).then((installation) => {
        if (!installation) return;
        setInstallations((current) => [...current.filter((item) => item.id !== installation.id), installation]);
        if (installation.status === 'ready' || installation.status === 'failed') {
          setInstalling(false);
          // Keep the pending id so the just-finished result stays visible.
          // Refresh the active pointer after the runtime switches atomically.
          void apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null).then((payload) => {
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
  const changePreferences = onPreferencesChange;
  const liveLogs = useLiveLogs(logSource);
  const updateRuntime = async (path: string, body?: unknown) => {
    const init: RequestInit = { method: body === undefined ? 'POST' : 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await apiFetch(path, init);
    if (response.ok) {
      const payload = await response.json() as ProcessState | TunnelState;
      if (path.includes('/process')) setProcessState(payload as ProcessState); else setTunnelState(payload as TunnelState);
    }
  };
  const activeInstallation = installations.find((item) => item.id === pendingInstallationId) ?? installations.find((item) => item.id === activeInstallationId) ?? installations.at(-1);
  const removeInstallation = async (): Promise<string | null> => {
    const response = await apiFetch('/api/v1/installations', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    if (!response.ok) {
      const payload = await response.json() as { error?: { message?: string } };
      return payload.error?.message ?? t('console.uninstallFailed');
    }
    setInstallations([]);
    setActiveInstallationId(null);
    setPendingInstallationId(null);
    return null;
  };
  const installation = <InstallationPanel t={t} catalog={catalog} version={version} onVersionChange={setVersion} versions={versions} installations={installations} activeInstallationId={activeInstallationId} pendingInstallationId={pendingInstallationId} onPendingInstallationId={setPendingInstallationId} csrfToken={csrfToken} installing={installing} onInstalling={setInstalling} running={processState.status === 'running'} onRemove={removeInstallation} />;
  const hero = <OverviewHero
    t={t}
    catalog={catalog}
    process={processState}
    tunnel={tunnelState}
    installed={Boolean(activeInstallationId)}
    installing={installing}
    active={activeInstallation}
    onStart={() => updateRuntime('/api/v1/process/start')}
    onStop={() => updateRuntime('/api/v1/process/stop')}
    onOpen={() => { window.open('http://127.0.0.1:8000', '_blank', 'noopener,noreferrer'); }}
  />;
  const logProps = { t, catalog, source: logSource, onSourceChange: setLogSource, entries: liveLogs.entries, query: logQuery, onQueryChange: setLogQuery, compact: compactLogs, onToggleCompact: () => setCompactLogs((current) => !current), onLoadOlder: liveLogs.loadOlder, hasOlder: liveLogs.hasOlder, loadingOlder: liveLogs.loadingOlder };
  const logs = <LogsPanel {...logProps} expanded={logsExpanded} onToggleExpanded={() => setLogsExpanded((current) => !current)} />;
  const updateConfig = async (input: ConfigUpdateInput): Promise<string | null> => {
    const response = await apiFetch('/api/v1/config', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(input) });
    const payload = await response.json() as { config?: ConfigDocument; process?: ProcessState; tunnel?: TunnelState; error?: { message?: string } };
    if (!response.ok || !payload.config) return payload.error?.message ?? t('console.configSaveFailed');
    setConfigDocument(payload.config);
    if (payload.process) setProcessState(payload.process);
    if (payload.tunnel) setTunnelState(payload.tunnel);
    return null;
  };
  const setAccessPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ password, confirmPassword }) });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return payload.error?.message ?? t('console.passwordSaveFailed');
    setAccessSecurity(payload);
    return null;
  };
  const setAccessLan = async (lan: boolean): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/network', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ lan }) });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return payload.error?.message ?? t('console.configSaveFailed');
    setAccessSecurity(payload);
    return null;
  };
  const changeManagerPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const response = await apiFetch('/api/v1/auth/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ password, confirmPassword }) });
    const payload = await response.json() as { error?: { message?: string } };
    return response.ok ? null : payload.error?.message ?? t('console.managerPasswordSaveFailed');
  };

  return (
    <Toaster>
      <SidebarProvider style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.75rem' } as CSSProperties}>
        <AppSidebar page={page} navigate={navigate} t={t} />
        <SidebarInset className="min-w-0">
          <header className="site-header">
            <div className="site-header-inner">
              {/* The trigger is desktop-only: below `md` the destinations are
                  along the bottom of the screen, where a thumb already is. */}
              <SidebarTrigger label={t('console.toggleNavigation')} className="-ml-2 hidden size-9 shrink-0 md:inline-flex" />
              <BrandMark size={26} className="md:hidden" />
              <h1>{t(`nav.${page}`)}</h1>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <Button variant="outline" size="sm" className="log-header-button" onClick={() => setLogsExpanded(true)}><ScrollText />{t('console.openLogs')}</Button>
                <LanguageControl t={t} preferences={preferences} onChange={changePreferences} />
                <Button variant="ghost" size="icon-sm" className="size-9" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => changePreferences({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
                  {preferences.theme === 'dark' ? <Sun /> : <Moon />}
                </Button>
              </div>
            </div>
          </header>
          <PageContainer>
            {page === 'overview' ? <div className="grid min-w-0 gap-(--section-gap)">{hero}<CardGrid>{installation}<AccessPanel t={t} process={processState} tunnel={tunnelState} config={configDocument} security={accessSecurity} installed={Boolean(activeInstallationId)} onAction={updateRuntime} onSetLan={setAccessLan} onSetPassword={setAccessPassword} /><DataPanel t={t} navigate={navigate} activeProfile={profiles.find((profile) => profile.id === activeProfileId) ?? null} latestBackup={backups.at(-1) ?? null} /><SystemPanel t={t} csrfToken={csrfToken ?? ''} />{logs}</CardGrid></div> : page === 'data' ? <DataPage t={t} catalog={catalog} csrfToken={csrfToken} profiles={profiles} activeProfileId={activeProfileId} backups={backups} onProfilesChange={(next, active) => { setProfiles(next); setActiveProfileId(active); }} onBackupsChange={setBackups} /> : page === 'metrics' ? <MetricsPage t={t} /> : page === 'config' ? <ConfigPage t={t} config={configDocument} onConfigUpdate={updateConfig} onChangeManagerPassword={changeManagerPassword} /> : <ResourcePanel page={page} t={t} />}
          </PageContainer>
          <MobileNav
            items={navigation.map(({ id, icon }) => ({ id, icon, href: `#${id}`, label: t(`nav.${id}`) }))}
            current={page}
            onNavigate={(id) => navigate(id as PageId)}
            label={t('console.navigation')}
          />
        </SidebarInset>
        <LogsSheet {...logProps} open={logsExpanded} onClose={() => setLogsExpanded(false)} />
      </SidebarProvider>
    </Toaster>
  );
}

function AppSidebar({ page, navigate, t }: { page: PageId; navigate: Navigate; t: Translate }) {
  const { setOpenMobile, isMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon" mobileTitle={t('console.navigation')}>
      <SidebarHeader className="brand-header">
        <a href="#overview" aria-label="SillyTavern Manager" className="brand" onClick={() => setOpenMobile(false)}>
          <BrandMark size={28} />
          <span className="truncate group-data-[collapsible=icon]:hidden">ST Manager</span>
        </a>
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

/**
 * What the overview opens with.
 *
 * The page used to begin with four cards of equal weight, and finding out
 * whether SillyTavern was up meant reading a badge in the corner of the first
 * one. The state, and the single most useful thing to do about it, now sit
 * above everything else.
 *
 * Start is a plain button; Stop asks first, because whoever is reading a chat
 * through the public link is not in the room to be consulted.
 */
function OverviewHero({ t, catalog, process, tunnel, installed, installing, active, onStart, onStop, onOpen }: { t: Translate; catalog: Record<string, unknown>; process: ProcessState; tunnel: TunnelState; installed: boolean; installing: boolean; active: Installation | undefined; onStart: () => Promise<void>; onStop: () => Promise<void>; onOpen: () => void }) {
  const [stopAsked, setStopAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = process.status === 'running';
  const pending = busy || process.status === 'starting' || process.status === 'stopping';
  const installingNow = installing || (active !== undefined && active.status !== 'ready' && active.status !== 'failed');

  const tone: StatusTone = installingNow || process.status === 'starting' || process.status === 'stopping'
    ? 'working'
    : running ? 'online'
      : process.status === 'error' || active?.status === 'failed' ? 'attention'
        : 'offline';


  const installFailed = active?.status === 'failed';
  const title = installingNow ? t('console.heroInstalling')
    : installFailed ? t('console.heroInstallFailed')
      : process.status === 'starting' ? t('console.heroStarting')
        : process.status === 'stopping' ? t('console.heroStopping')
          : process.status === 'error' ? t('console.heroFailed')
            : running ? t('console.heroRunning')
              : installed ? t('console.heroStopped')
                : t('console.heroNotInstalled');

  // What is worth saying under the title, in the order it becomes true: what
  // the install is doing, then why it failed, then where it can be reached.
  const detail = installingNow && active
    ? `${translateStep(active.step, catalog, active.stepCode, active.stepParams)} · ${Math.round(active.progress)}%`
    : (installFailed ? active?.error ?? process.error : process.error)
      ?? active?.resolvedRef ?? null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };

  // Before the first install there is no state to report and nothing here to
  // press, and a banner saying "not installed" above a card headed SillyTavern
  // with an Install button in it is a band of empty space in the way. The hero
  // arrives with the thing it describes - or with the reason it is not there,
  // because an install that failed leaves nothing installed and its error is
  // the most important thing on the page.
  if (!installed && !installingNow && !installFailed) return null;

  return <>
    <StatusHero
      tone={tone}
      title={title}
      detail={detail}
      {...(installingNow && active ? { progress: active.progress } : {})}
      actions={installed ? <>
        <Button variant="outline" onClick={onOpen} disabled={!running}><ArrowUpRight />{t('dashboard.open')}</Button>
        {running
          ? <Button variant="outline" onClick={() => setStopAsked(true)} disabled={pending}><Square />{t('dashboard.stop')}</Button>
          : <Button onClick={() => void run(onStart)} disabled={pending || installingNow}><Play />{pending ? t('common.loading') : t('dashboard.start')}</Button>}
      </> : null}
    />
    <ConfirmDialog
      open={stopAsked}
      onOpenChange={setStopAsked}
      title={t('console.stopConfirm')}
      description={t('console.stopConfirmBody')}
      confirmLabel={t('dashboard.stop')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => run(onStop)}
    />
  </>;
}

/**
 * Choosing a version and putting it on the disk.
 *
 * Starting and stopping used to sit in this card's footer, next to a version
 * select they had nothing to do with, so the button that ran SillyTavern was
 * beside the button that replaced it. Running belongs to the hero above, which
 * is where the state it changes is reported. What is left here is the install,
 * and the install now asks before it restarts something that is already up.
 */
function InstallationPanel({ t, catalog, version, onVersionChange, versions, installations, activeInstallationId, pendingInstallationId, onPendingInstallationId, csrfToken, installing, onInstalling, running, onRemove }: { t: Translate; catalog: Record<string, unknown>; version: string; onVersionChange: (value: string) => void; versions: VersionOption[]; installations: Installation[]; activeInstallationId: string | null; pendingInstallationId: string | null; onPendingInstallationId: (value: string | null) => void; csrfToken: string | null; installing: boolean; onInstalling: (value: boolean) => void; running: boolean; onRemove: () => Promise<string | null> }) {
  const [requestError, setRequestError] = useState<string | null>(null);
  const [askedVersion, setAskedVersion] = useState<string | null>(null);
  const [askedRemove, setAskedRemove] = useState(false);
  const active = installations.find((item) => item.id === pendingInstallationId) ?? installations.find((item) => item.id === activeInstallationId) ?? installations.at(-1);
  const installed = Boolean(activeInstallationId);
  // A word, not the running commentary: the hero above is already saying what
  // the install is doing and how far along it is.
  const status = active?.status === 'ready' ? t('dashboard.ready')
    : active?.status === 'failed' ? t('dashboard.installFailed')
      : active ? t('common.loading')
        : t('dashboard.notInstalled');
  const canInstall = Boolean(csrfToken) && !installing;
  const choices = versions.length > 0 ? versions : [{ selector: 'latest', label: `${t('dashboard.latest')} (latest)`, ref: 'latest', channel: 'release', tag: null, publishedAt: null }, { selector: 'release', label: 'release', ref: 'release', channel: 'release', tag: null, publishedAt: null }, { selector: 'staging', label: 'staging', ref: 'staging', channel: 'staging', tag: null, publishedAt: null }] satisfies VersionOption[];
  const chosen = choices.find((choice) => choice.selector === version);
  const chosenLabel = chosen?.label ?? version;
  /*
   * Whether pressing Install would do nothing.
   *
   * Compared on the ref each option resolves to, not on the name of the
   * option. "latest" is a moving target: matching on the word would lock the
   * one choice most people leave selected, so an upstream release could never
   * be installed. Matching on the ref it currently points at disables the
   * button only while the installed copy really is that ref.
   */
  const installedRef = active?.status === 'ready' ? active.resolvedRef : null;
  const alreadyInstalled = installedRef !== null && chosen !== undefined && chosen.ref === installedRef;

  const install = async () => {
    if (!csrfToken) return;
    setRequestError(null);
    onInstalling(true);
    try {
      const response = await apiFetch('/api/v1/installations', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ version }) });
      const payload = await response.json() as { installationId?: string; error?: { message?: string } };
      if (!response.ok) { setRequestError(payload.error?.message ?? t('console.installRequestFailed')); onInstalling(false); return; }
      if (!payload.installationId) { setRequestError(t('console.installRequestFailed')); onInstalling(false); return; }
      onPendingInstallationId(payload.installationId);
    } catch { setRequestError(t('console.installRequestFailed')); onInstalling(false); }
  };

  // The first install has nothing to interrupt. Every one after it replaces a
  // working copy and restarts it, which is worth a question.
  const requestInstall = () => { if (installed || running) setAskedVersion(version); else void install(); };

  const remove = async () => {
    setRequestError(null);
    setRequestError(await onRemove());
  };

  return <Card data-tour="installation">
    <PanelHeading icon={<Package />} action={<Badge variant="outline" className={active?.status === 'ready' ? '' : 'status-attention'}>{status}</Badge>}>SillyTavern</PanelHeading>
    <CardContent className="flex-1">
      <label className="field-label" htmlFor="install-version">{t('dashboard.version')}</label>
      <Select value={version} onValueChange={onVersionChange}><SelectTrigger id="install-version" className="w-full"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start" className="version-select-content">{choices.map((choice) => <SelectItem key={choice.selector} value={choice.selector}>{choice.label}</SelectItem>)}</SelectContent></Select>
      {active?.status === 'ready' ? <p className="install-result">{t('console.installComplete')} · {active.resolvedRef}</p> : null}
      {requestError ? <p className="install-error" role="alert">{requestError}</p> : null}
    </CardContent>
    <CardFooter className="flex-col items-stretch gap-2">
      {alreadyInstalled
        ? <Tooltip><TooltipTrigger asChild><span className="inline-flex"><Button variant="outline" className="w-full" disabled><Download />{t('console.versionInstalled')}</Button></span></TooltipTrigger><TooltipContent>{t('console.versionInstalledHint')}</TooltipContent></Tooltip>
        : <Button variant="outline" className="w-full" onClick={requestInstall} disabled={!canInstall}><Download />{installing ? t('common.loading') : t('dashboard.install')}</Button>}
      {installed ? <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => setAskedRemove(true)} disabled={installing}><Trash2 />{t('console.uninstall')}</Button> : null}
    </CardFooter>
    <ConfirmDialog
      open={askedVersion !== null}
      onOpenChange={(open) => { if (!open) setAskedVersion(null); }}
      tone="default"
      title={t('console.installConfirm', { version: chosenLabel })}
      description={t('console.installConfirmBody')}
      confirmLabel={t('dashboard.install')}
      cancelLabel={t('common.cancel')}
      onConfirm={install}
    />
    <ConfirmDialog
      open={askedRemove}
      onOpenChange={setAskedRemove}
      title={t('console.uninstallConfirm')}
      description={t('console.uninstallConfirmBody')}
      confirmLabel={t('console.uninstall')}
      cancelLabel={t('common.cancel')}
      onConfirm={remove}
    />
  </Card>;
}

function AccessPanel({ t, process, tunnel, config, security, installed, onAction, onSetLan, onSetPassword }: { t: Translate; process: ProcessState; tunnel: TunnelState; config: ConfigDocument | null; security: AccessGatewayState; installed: boolean; onAction: (path: string, body?: unknown) => Promise<void>; onSetLan: (lan: boolean) => Promise<string | null>; onSetPassword: (password: string, confirmPassword: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const running = process.status === 'running';
  /**
   * Whether the tunnel is meant to be open, rather than whether it is up.
   *
   * The tunnel outlives SillyTavern now - it publishes the access gateway, so a
   * restart or a restore leaves the address alone, and an exit nobody asked for
   * is reconnected. Reading the switch off the live status meant a tunnel that
   * was between attempts looked off, and one that was reconnecting could not be
   * turned off at all.
   */
  const tunnelWanted = tunnel.mode !== 'off';
  // The door is the manager's own, so its password and its reach are known
  // whether or not SillyTavern happens to be up. Nothing here has to wait for
  // a version to answer, and no reading is ever "unknown".
  const passwordReady = security.passwordConfigured;
  const lan = security.lan;
  const lanLabel = lan ? t('console.lanEnabled') : t('console.lanDisabled');
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Turning either of these off takes an address away from whoever is on the
  // other end of it, and they are not in the room to be asked.
  const [closing, setClosing] = useState<'tunnel' | 'lan' | null>(null);
  const runAction = async (path: string, body?: unknown) => { setBusy(true); try { await onAction(path, body); } finally { setBusy(false); } };
  const setTunnel = async (on: boolean) => { await runAction('/api/v1/tunnel', { mode: on ? 'quick' : 'off' }); };
  const toggleTunnel = (next: boolean) => { if (next) void setTunnel(true); else setClosing('tunnel'); };
  const setLanTo = async (next: boolean) => {
    setSecurityBusy(true); setSecurityMessage(null);
    try { setSecurityMessage(await onSetLan(next)); } finally { setSecurityBusy(false); }
  };
  const toggleLan = (next: boolean) => { if (next) void setLanTo(true); else setClosing('lan'); };
  // This machine reaches SillyTavern directly, because the loopback address is
  // already a boundary. Everything else goes through the gateway and its
  // password: the LAN address and the tunnel both point there.
  const localHost = '127.0.0.1:8000';
  const lanHost = `${config?.networkHost ?? window.location.hostname ?? 'localhost'}:${security.port}`;
  const localUrl = `http://${localHost}`;
  const lanUrl = `http://${lanHost}`;
  const openLocal = () => { window.open(localUrl, '_blank', 'noopener,noreferrer'); };
  const copyTunnel = async () => { if (tunnel.url) await navigator.clipboard?.writeText(tunnel.url); };
  // The address another device can actually reach, best first. Nobody needs a
  // code for 127.0.0.1 - the only device that can open it is this one.
  const shareUrl = tunnel.url ?? (lan ? lanUrl : null);
  const shareLabel = tunnel.url ? t('dashboard.publicAddress') : t('console.lanAddress');
  const [qrOpen, setQrOpen] = useState(false);
  return <Card data-tour="public-access">
    <PanelHeading icon={<Globe2 />} action={<Badge variant="secondary" className={running ? 'status-online' : tunnel.error ? 'status-attention' : ''}>{running ? t('console.online') : t('dashboard.offline')}</Badge>}>{t('console.publicAccess')}</PanelHeading>
    <CardContent className="flex-1 space-y-4">
      <div className="access-row"><div><strong>{t('console.lanAccess')}</strong><span>{lan ? lanLabel : passwordReady ? lanLabel : t('console.passwordRequired')}</span></div><Switch id="listen-switch" checked={lan} onCheckedChange={toggleLan} disabled={!installed || securityBusy || (!lan && !passwordReady)} aria-label={t('console.enableLan')} /></div>
      <dl className="address-list"><div><dt>{t('console.lanAddress')}</dt><dd><AddressLink t={t} href={lanUrl}>{lanHost}</AddressLink></dd></div><div><dt>{t('console.local')}</dt><dd><AddressLink t={t} href={localUrl}>{localHost}</AddressLink></dd></div></dl>
      <div className="access-row access-row-public"><div><strong>{t('console.quickTunnel')}</strong><span>{passwordReady ? t('console.passwordProtected') : t('console.passwordRequired')}</span></div><Switch id="tunnel-switch" checked={tunnelWanted} onCheckedChange={toggleTunnel} disabled={busy || (tunnelWanted ? false : !installed || !running || !passwordReady)} aria-label={t('console.enableTunnel')} /></div>
      <dl className="address-list"><div><dt>{t('dashboard.publicAddress')}</dt><dd>{tunnel.url ? <AddressLink t={t} href={tunnel.url}>{tunnel.url}</AddressLink> : '—'}</dd></div></dl>
      {shareUrl ? <div className="access-qr"><Button variant="ghost" size="sm" onClick={() => setQrOpen((open) => !open)} aria-expanded={qrOpen}><QrCodeIcon />{qrOpen ? t('console.hideQr') : t('console.showQr')}</Button>{qrOpen ? <figure><QrCode value={shareUrl} label={`${shareLabel}: ${shareUrl}`} /><figcaption>{t('console.scanToOpen')} · {shareLabel}</figcaption></figure> : null}</div> : null}
      <div className="access-row"><div><strong>{t('console.passwordSettings')}</strong><span>{passwordReady ? t('console.passwordProtected') : t('console.passwordRequired')}</span></div><Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>{passwordReady ? t('console.changePassword') : t('console.savePassword')}</Button></div>
      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(open) => { if (!open) setClosing(null); }}
        title={closing === 'lan' ? t('console.lanOffConfirm') : t('console.tunnelOffConfirm')}
        description={closing === 'lan' ? t('console.lanOffConfirmBody') : t('console.tunnelOffConfirmBody')}
        confirmLabel={t('common.turnOff')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => { if (closing === 'lan') await setLanTo(false); else await setTunnel(false); }}
      />
      <PasswordDialog t={t} open={passwordOpen} onOpenChange={setPasswordOpen} title={t('console.passwordSettings')} description={t('console.sillyPasswordHelp')} note={passwordReady ? t('console.passwordChangeSignsOut') : null} minLength={MIN_SILLY_PASSWORD} hint={t('console.sillyPasswordMin')} submitLabel={passwordReady ? t('console.changePassword') : t('console.savePassword')} onSubmit={onSetPassword} />
      {busy || securityBusy ? <div className="operation-progress" role="status"><span>{t('common.loading')}</span><span className="progress-track"><span className="progress-indeterminate" /></span></div> : null}
      {security.error ? <p className="install-error" role="alert">{security.error}</p> : null}
      {securityMessage ? <p className="install-error" role="alert">{securityMessage}</p> : null}
      {tunnel.error ? <p className="install-error" role="alert">{tunnel.error}</p> : null}
    </CardContent>
    <CardFooter className="gap-2"><Button variant="outline" onClick={openLocal} disabled={!running}><ArrowUpRight />{t('dashboard.open')}</Button><Button variant="ghost" onClick={() => void copyTunnel()} disabled={!tunnel.url}><Copy />{t('dashboard.copyLink')}</Button></CardFooter>
  </Card>;
}

/**
 * Setting a password, wherever a password is set.
 *
 * There are two, and they open different things: one lets a browser into this
 * manager, the other lets a browser into SillyTavern. They used to be asked
 * for in two different shapes on two different pages - a collapsed section on
 * the access card, a pair of bare fields on the settings page - so the only
 * way to tell which one was being changed was to already know. Both are asked
 * for here, named after what they open, and only when the reader asks.
 */
function PasswordDialog({ t, open, onOpenChange, title, description, note, minLength, hint, submitLabel, onSubmit }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; note?: string | null; minLength: number; hint: string; submitLabel: string; onSubmit: (password: string, confirmPassword: string) => Promise<string | null> }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Flagged once the second field stops being a prefix of the first, rather
  // than the moment the two differ - a warning under a half-typed password is
  // noise that goes away on its own.
  const mismatch = confirmPassword.length > 0 && !password.startsWith(confirmPassword);
  const ready = password.length >= minLength && password === confirmPassword;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) { setPassword(''); setConfirmPassword(''); setError(null); }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onSubmit(password, confirmPassword);
      setError(failure);
      if (!failure) close(false);
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <Field label={t('console.password')} hint={hint}>
            <PasswordInput revealLabel={t('setup.reveal')} hideLabel={t('setup.hide')} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Field label={t('console.confirmPassword')} error={mismatch ? t('setup.mismatch') : null}>
            <PasswordInput revealLabel={t('setup.reveal')} hideLabel={t('setup.hide')} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </Field>
          {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={busy || !ready}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** An address that opens in its own tab rather than sitting there as text. */
function AddressLink({ t, href, children }: { t: Translate; href: string; children: ReactNode }) {
  return <a className="address-link" href={href} target="_blank" rel="noopener noreferrer" title={t('console.openInNewTab')}><code>{children}</code><ArrowUpRight aria-hidden="true" /></a>;
}

/**
 * Where the data stands, and one way through to it.
 *
 * This card had four controls - a link in the body, two buttons in the footer
 * and an advert pinned under them - and all four went to the same page. It
 * also carried a standing recommendation to set up off-machine backups, which
 * is advice printed on a page rather than offered where it can be acted on;
 * that belongs next to the setting itself.
 */
function DataPanel({ t, navigate, activeProfile, latestBackup }: { t: Translate; navigate: Navigate; activeProfile: Profile | null; latestBackup: BackupManifest | null }) {
  return <Card data-tour="data">
    <PanelHeading icon={<Database />}>{t('console.data')}</PanelHeading>
    <CardContent className="flex-1">
      {latestBackup
        ? <div className="grid gap-1">
          <DetailRow label={t('console.activeProfile')}>{activeProfile?.name ?? t('console.noProfiles')}</DetailRow>
          <DetailRow label={t('status.lastBackup')}>{new Date(latestBackup.createdAt).toLocaleString()}</DetailRow>
        </div>
        : <EmptyState
          icon={<Archive />}
          title={t('dashboard.noBackup')}
          action={<Button size="sm" onClick={() => navigate('data')}><Archive />{t('dashboard.backupNow')}</Button>}
        />}
    </CardContent>
    {latestBackup ? <CardFooter><Button variant="outline" className="w-full" onClick={() => navigate('data')}><Database />{t('nav.data')}<ArrowUpRight /></Button></CardFooter> : null}
  </Card>;
}

interface LogViewProps {
  readonly t: Translate;
  readonly catalog: Record<string, unknown>;
  readonly source: LogSourceFilter;
  readonly onSourceChange: (value: LogSourceFilter) => void;
  readonly entries: LogEntry[];
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly compact: boolean;
  readonly onToggleCompact: () => void;
  readonly onLoadOlder: () => void;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

function LogsPanel({ expanded, onToggleExpanded, ...contentProps }: LogViewProps & { expanded: boolean; onToggleExpanded: () => void }) {
  const { t } = contentProps;
  // While the sheet is open the card keeps its footprint but not its content,
  // so the page behind does not reflow and the log is not rendered twice.
  const cardContents = expanded ? <div className="log-card-placeholder" aria-hidden="true" /> : <LogsContent {...contentProps} />;
  return <Card data-tour="logs" data-expanded={expanded}><PanelHeading icon={<ScrollText />} action={<Button variant="ghost" size="sm" onClick={onToggleExpanded} aria-label={t('console.expandLogs')}><Maximize2 />{t('console.expandLogs')}</Button>}>{t('console.liveLogs')}</PanelHeading>{cardContents}</Card>;
}

/**
 * The expanded log, mounted for every page rather than only the overview, so
 * the header button can reach it from wherever the operator happens to be.
 */
function LogsSheet({ open, onClose, ...contentProps }: LogViewProps & { open: boolean; onClose: () => void }) {
  const { t } = contentProps;
  return <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <SheetContent side="bottom" className="log-sheet" showCloseButton={false}>
      <SheetHeader className="log-sheet-header"><SheetTitle>{t('console.liveLogs')}</SheetTitle><Button variant="ghost" size="sm" onClick={onClose}><Minimize2 />{t('console.collapseLogs')}</Button></SheetHeader>
      <LogsContent {...contentProps} expanded />
    </SheetContent>
  </Sheet>;
}

/** Distance from the bottom, in pixels, still treated as "following the tail". */
const LOG_FOLLOW_SLACK = 48;
/** Distance from the top that asks for the previous page of retained lines. */
const LOG_BACKFILL_SLACK = 120;

function LogsContent({ t, catalog, source, onSourceChange, entries, query, onQueryChange, compact, onToggleCompact, onLoadOlder, hasOlder, loadingOlder, expanded = false }: { t: Translate; catalog: Record<string, unknown>; source: LogSourceFilter; onSourceChange: (value: LogSourceFilter) => void; entries: LogEntry[]; query: string; onQueryChange: (value: string) => void; compact: boolean; onToggleCompact: () => void; onLoadOlder: () => void; hasOlder: boolean; loadingOlder: boolean; expanded?: boolean }) {
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  // Prepending history moves everything down; remember where the top was so the
  // reader keeps looking at the same line instead of being thrown forward.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = normalizedQuery.length === 0 ? entries : entries.filter((entry) => `${entry.source} ${entry.message}`.toLocaleLowerCase().includes(normalizedQuery));
  const showSource = source === 'all';
  const latestVisibleId = visibleEntries.at(-1)?.id;
  const oldestVisibleId = visibleEntries[0]?.id;

  const scrollToLatest = () => {
    const element = logViewportRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setFollowing(true);
    setUnread(0);
  };

  const onScroll = () => {
    const element = logViewportRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= LOG_FOLLOW_SLACK;
    setFollowing(atBottom);
    if (atBottom) setUnread(0);
    if (element.scrollTop <= LOG_BACKFILL_SLACK && hasOlder && !loadingOlder && normalizedQuery.length === 0) {
      anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      onLoadOlder();
    }
  };

  // Following the tail is the default, but scrolling up has to hold its place:
  // a restore writes a line every second and would otherwise drag the reader
  // back to the bottom mid-sentence.
  useEffect(() => {
    const element = logViewportRef.current;
    if (!element) return;
    if (following) { element.scrollTop = element.scrollHeight; return; }
    setUnread((current) => current + 1);
  }, [latestVisibleId]);

  useEffect(() => {
    const element = logViewportRef.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [normalizedQuery, source, compact, expanded]);

  useEffect(() => {
    const element = logViewportRef.current;
    const previous = anchor.current;
    if (!element || !previous) return;
    anchor.current = null;
    element.scrollTop = previous.top + (element.scrollHeight - previous.height);
  }, [oldestVisibleId]);
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
    <div className="log-viewport">
      <div className="log-view" ref={logViewportRef} onScroll={onScroll} role="log" tabIndex={0} aria-label={t('console.liveLogs')}>
        {visibleEntries.length === 0 ? <span className="log-empty">{normalizedQuery ? t('console.noLogMatches') : t('console.noLogs')}</span> : <div className="log-lines">
          {normalizedQuery.length === 0 && hasOlder ? <div className="log-history-hint">{loadingOlder ? t('console.loadingOlderLogs') : <button type="button" onClick={onLoadOlder}>{t('console.loadOlderLogs')}</button>}</div> : null}
          {visibleEntries.map((entry) => <div className="log-line" key={entry.id}>
            {compact ? null : <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false })}</time>}
            {showSource ? <span className="log-source">{entry.source}</span> : null}
            <span className="log-message">{translateLogEntry(entry, catalog)}</span>
          </div>)}
        </div>}
      </div>
      {following ? null : <button type="button" className="log-jump" onClick={scrollToLatest} aria-label={unread > 0 ? t('console.newLogLines') : t('console.jumpToLatest')}>
        <ArrowDown aria-hidden="true" />
        <span>{t('console.jumpToLatest')}</span>
        {unread > 0 ? <span className="log-jump-dot" aria-hidden="true" /> : null}
      </button>}
    </div>
  </div>;
}

/** The labels every table in the console borrows, in the reader's language. */
function tableLabels(t: Translate): DataTableLabels {
  return {
    search: t('table.search'),
    perPage: t('table.perPage'),
    count: (shown, total) => t('table.count', { shown, total }),
    sortAscending: t('table.sortAscending'),
    sortDescending: t('table.sortDescending'),
    navigation: t('table.navigation'),
    previous: t('table.previous'),
    next: t('table.next'),
    page: (page, of) => t('table.page', { page, of }),
  };
}

/**
 * The stand-in the server hands back for a key it is holding.
 *
 * Sending it back unchanged means "leave the stored one alone", so a configured
 * bucket can be edited without its secret ever reaching a browser.
 */
const SECRET_MASK = '********';

interface R2FormState {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly enabled: boolean;
  readonly localIntervalMinutes: number;
  readonly hotIntervalMinutes: number;
  readonly coldIntervalHours: number;
  readonly keepRecent: number;
  readonly keepDaily: number;
  readonly keepWeekly: number;
}

function r2FormFrom(config: R2Config | null): R2FormState {
  return {
    endpoint: config?.endpoint ?? '',
    bucket: config?.bucket ?? '',
    accountId: config?.accountId ?? '',
    accessKeyId: config?.accessKeyIdMasked ? SECRET_MASK : '',
    secretAccessKey: config?.secretAccessKeyConfigured ? SECRET_MASK : '',
    enabled: config?.enabled ?? false,
    localIntervalMinutes: config?.schedule.localIntervalMinutes ?? 60,
    hotIntervalMinutes: config?.schedule.hotIntervalMinutes ?? 5,
    coldIntervalHours: config?.schedule.coldIntervalHours ?? 6,
    keepRecent: config?.retention.keepRecent ?? 48,
    keepDaily: config?.retention.keepDaily ?? 14,
    keepWeekly: config?.retention.keepWeekly ?? 8,
  };
}

/**
 * The profiles, the backups and the off-machine copy.
 *
 * The page used to be three cards of exposed machinery: a disclosure triangle
 * hiding a text box, a list of archives with four buttons on every row, and
 * eleven R2 settings sitting open on the page whether or not anybody had a
 * bucket. Nothing could be searched, a long list of backups could only be
 * scrolled, and the two questions that cannot be undone - restoring over a
 * profile and deleting an archive - were asked by `window.confirm` and
 * `window.prompt`, which cannot be translated and ask in the browser's voice
 * rather than this program's.
 *
 * Each card now asks one thing and keeps the rest behind a dialog, and the
 * archives are a table that can be searched, sorted and paged.
 */
function DataPage({ t, catalog, csrfToken, profiles, activeProfileId, backups, onProfilesChange, onBackupsChange }: { t: Translate; catalog: Record<string, unknown>; csrfToken: string; profiles: Profile[]; activeProfileId: string | null; backups: BackupManifest[]; onProfilesChange: (profiles: Profile[], activeProfileId: string | null) => void; onBackupsChange: (backups: BackupManifest[]) => void }) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('replace');
  const [selectedBackup, setSelectedBackup] = useState<BackupManifest | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<RestorePreview | null>(null);
  const [operationProgress, setOperationProgress] = useState<{ percent: number; step: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  // What the Stop button acts on: a server job by id, or the upload in flight.
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const [r2Config, setR2Config] = useState<R2Config | null>(null);
  const [r2Snapshots, setR2Snapshots] = useState<R2SnapshotSummary[]>([]);
  const [r2Busy, setR2Busy] = useState<string | null>(null);
  const [r2Message, setR2Message] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BackupManifest | null>(null);
  // Which archive is being deleted, and whether the question is on screen. The
  // two are separate because the dialog fades out: clearing the row at the same
  // moment left the title reading "Delete ?" for the length of the animation.
  const [deleteTarget, setDeleteTarget] = useState<BackupManifest | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [r2Open, setR2Open] = useState(false);
  // Newest first: the archive somebody wants is nearly always the last one taken.
  const [backupQuery, setBackupQuery] = useState<TableQuery>(() => initialQuery({ sort: 'createdAt', direction: 'desc' }));
  const [snapshotQuery, setSnapshotQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 5, sort: 'createdAt', direction: 'desc' }));
  const busy = busyAction !== null;
  const labels = tableLabels(t);
  const jobStep = (job: Job) => translateStep(job.step, catalog, job.stepCode, job.stepParams);
  const refresh = async () => {
    const [profileResponse, backupResponse, r2Response, snapshotResponse] = await Promise.all([apiFetch('/api/v1/profiles', { credentials: 'same-origin' }), apiFetch('/api/v1/backups', { credentials: 'same-origin' }), apiFetch('/api/v1/r2', { credentials: 'same-origin' }), apiFetch('/api/v1/r2/snapshots', { credentials: 'same-origin' }).catch(() => null)]);
    // Listing recovery points needs the bucket, so it is the one call here that
    // fails when R2 is off or unreachable. That must not blank the page.
    if (snapshotResponse?.ok) setR2Snapshots((await snapshotResponse.json() as { snapshots: R2SnapshotSummary[] }).snapshots);
    else setR2Snapshots([]);
    if (profileResponse.ok) { const payload = await profileResponse.json() as { profiles: Profile[]; activeProfileId: string | null }; onProfilesChange(payload.profiles, payload.activeProfileId); }
    if (backupResponse.ok) { const payload = await backupResponse.json() as { backups: BackupManifest[] }; onBackupsChange(payload.backups); }
    if (r2Response.ok) setR2Config((await r2Response.json() as { config: R2Config }).config);
  };
  useEffect(() => { void refresh(); }, []);

  // A restore runs in the server for minutes. Reloading the page must show the
  // one already in flight rather than an idle screen the operator would be
  // tempted to start a second restore from.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/jobs/active', { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json() as { job: Job | null };
        if (cancelled || !payload.job) return;
        const running = payload.job;
        setBusyAction(running.kind === 'restore' ? t('console.restore') : t('dashboard.backupNow'));
        setOperationProgress({ percent: running.progress, step: jobStep(running) });
        setRunningJobId(running.id);
        await waitForOperation(running.id, (job) => { if (!cancelled) setOperationProgress({ percent: job.progress, step: jobStep(job) }); });
        if (!cancelled) await refresh();
      } catch (error: unknown) {
        if (!cancelled) setError(error instanceof Error ? error.message : t('console.backupRestoreFailed'));
      } finally {
        if (!cancelled) { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Stop whatever is running now.
   *
   * An upload is stopped in the browser, because that is where the bytes still
   * are. A backup or restore is stopped in the server, which is where the work
   * is; it stops between whole files and the pre-restore snapshot is the way
   * back from a restore that got part of the way through.
   */
  const stopOperation = async () => {
    setStopping(true);
    try {
      uploadAbort.current?.abort();
      if (runningJobId) await apiFetch(`/api/v1/jobs/${encodeURIComponent(runningJobId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    } catch {
      // The poll below reports what actually happened either way.
    } finally {
      setStopping(false);
    }
  };

  // Chunks are held in the browser until the last one lands, so a reload or a
  // navigation away throws the whole upload out. Warn before that happens.
  useEffect(() => {
    if (!uploading) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  const createProfile = async (name: string): Promise<string | null> => {
    setBusyAction(t('console.newProfile')); setError(null);
    try {
      const response = await apiFetch('/api/v1/profiles', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name, layout: 'data' }) });
      if (!response.ok) { const payload = await response.json() as { error?: { message?: string } }; return payload.error?.message ?? t('console.profileCreateFailed'); }
      await refresh();
      return null;
    } catch { return t('console.profileCreateFailed'); } finally { setBusyAction(null); }
  };
  const activate = async (id: string) => {
    setBusyAction(t('console.switchProfile')); setError(null);
    try {
      const response = await apiFetch(`/api/v1/profiles/${id}/activate`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { const payload = await response.json() as { error?: { message?: string } }; setError(payload.error?.message ?? t('console.profileActivateFailed')); return; }
      await refresh();
    } catch { setError(t('console.profileActivateFailed')); } finally { setBusyAction(null); }
  };
  const createBackup = async (name: string): Promise<string | null> => {
    setBusyAction(t('dashboard.backupNow')); setOperationProgress({ percent: 0, step: t('dashboard.backupNow') }); setError(null);
    try {
      const response = await apiFetch('/api/v1/backups', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ ...(name ? { name } : {}) }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) return payload.error?.message ?? t('console.backupCreateFailed');
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh();
      return null;
    } catch (error: unknown) {
      // Stopping is an answer rather than a failure: the dialog closes and the
      // list says what is actually there.
      if (error instanceof StoppedError) { await refresh(); return null; }
      return error instanceof Error ? error.message : t('console.backupCreateFailed');
    } finally { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
  };
  const waitForOperation = async (jobId: string, onUpdate: (job: Job) => void): Promise<void> => {
    for (;;) {
      const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(t('console.backupRestoreFailed'));
      const job = await response.json() as Job;
      onUpdate(job);
      if (job.state === 'succeeded') return;
      if (job.state === 'canceled') throw new StoppedError();
      if (job.state === 'failed') throw new Error(job.error ?? t('console.backupRestoreFailed'));
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 700));
    }
  };
  const previewBackup = async (backup: BackupManifest) => {
    setBusyAction(t('console.restore')); setError(null);
    try {
      const response = await apiFetch(`/api/v1/backups/${backup.id}/preview`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as RestorePreview | { error?: { message?: string } };
      if (!response.ok || !('files' in payload)) { setError(('error' in payload ? payload.error?.message : undefined) ?? t('console.backupPreviewFailed')); return; }
      setRestoreMode('replace');
      setSelectedBackup(backup); setSelectedPreview(payload);
    } catch { setError(t('console.backupPreviewFailed')); } finally { setBusyAction(null); }
  };
  const closeRestore = () => { setSelectedBackup(null); setSelectedPreview(null); };
  const restoreSelected = async () => {
    if (!selectedBackup || !selectedPreview) return;
    const backupId = selectedBackup.id;
    // The question has been answered, so the dialog goes before the work
    // starts: what happens next belongs on the page, where the Stop button is.
    closeRestore();
    setBusyAction(t('console.restore')); setOperationProgress({ percent: 0, step: t('console.restore') }); setError(null);
    try {
      const response = await apiFetch(`/api/v1/backups/${backupId}/restore`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: restoreMode }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { setError(payload.error?.message ?? t('console.backupRestoreFailed')); return; }
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh();
    } catch (error: unknown) {
      // A restore that was stopped part of the way through left the profile
      // part old and part new. Say so, and say where the way back is.
      if (error instanceof StoppedError) { setError(t('console.restoreStoppedPartway')); await refresh(); }
      else setError(error instanceof Error ? error.message : t('console.backupRestoreFailed'));
    } finally { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
  };
  const inspectUpload = async (file: File | undefined) => {
    if (!file) return;
    setBusyAction(t('console.importZip')); setOperationProgress({ percent: 0, step: t('console.importZip') }); setError(null); setUploading(true);
    const controller = new AbortController();
    uploadAbort.current = controller;
    const uploadId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      let index = 0;
      // Rate over the last few seconds rather than over the whole upload, so a
      // connection that has just slowed down says so instead of averaging the
      // slowdown away against the minutes that went before it.
      const samples: Array<{ at: number; bytes: number }> = [{ at: Date.now(), bytes: 0 }];
      for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
        const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
        await uploadChunkWithRetry(
          `/api/v1/backups/import/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`,
          file.slice(offset, end),
          { 'content-type': 'application/octet-stream', 'x-csrf-token': csrfToken, accept: 'application/json' },
          controller.signal,
        );
        index += 1;
        const at = Date.now();
        samples.push({ at, bytes: end });
        while (samples.length > 2 && at - (samples[0]?.at ?? at) > UPLOAD_RATE_WINDOW_MS) samples.shift();
        const oldest = samples[0] ?? { at, bytes: 0 };
        const elapsedMs = at - oldest.at;
        const bytesPerSecond = elapsedMs > 0 ? ((end - oldest.bytes) / elapsedMs) * 1000 : 0;
        const remaining = bytesPerSecond > 0 ? `${formatDuration((file.size - end) / bytesPerSecond)} ${t('console.uploadRemaining')}` : t('console.uploadEstimating');
        setOperationProgress({
          percent: Math.round((end / Math.max(file.size, 1)) * 100),
          step: `${t('console.uploading')} ${formatBytes(end)} / ${formatBytes(file.size)} · ${formatBytes(Math.round(bytesPerSecond))}/s · ${remaining}`,
        });
      }
      // Every chunk is on the server now, so it owns the rest of the work and
      // leaving the page no longer loses anything.
      setUploading(false);
      setOperationProgress({ percent: 100, step: t('console.importFinishing') });
      const response = await apiFetch('/api/v1/backups/import/finish', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ uploadId, name: file.name, expectedBytes: file.size }) });
      const text = await response.text();
      let payload: (RestorePreview & { backup?: BackupManifest }) | { error?: { message?: string } };
      try { payload = JSON.parse(text) as (RestorePreview & { backup?: BackupManifest }) | { error?: { message?: string } }; }
      catch { throw new Error(apiErrorFromText(text, response.status, t('console.backupPreviewFailed'))); }
      if (!response.ok || !('files' in payload)) { setError(('error' in payload ? payload.error?.message : undefined) ?? t('console.backupPreviewFailed')); return; }
      if (!payload.backup) { setError(t('console.backupPreviewFailed')); return; }
      setRestoreMode('replace');
      setSelectedBackup(payload.backup); setSelectedPreview(payload);
      await refresh();
    } catch (error: unknown) {
      // The part file on the server is worth nothing without the rest of it,
      // whether the upload failed or the operator stopped it.
      await apiFetch(`/api/v1/backups/import/chunk?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
      setError(error instanceof StoppedError ? null : error instanceof Error ? error.message : t('console.backupPreviewFailed'));
    } finally { uploadAbort.current = null; setBusyAction(null); setOperationProgress(null); setUploading(false); }
  };
  const renameBackup = async (name: string): Promise<string | null> => {
    if (!renameTarget) return null;
    setBusyAction(t('common.rename')); setError(null);
    try {
      const response = await apiFetch(`/api/v1/backups/${renameTarget.id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name }) });
      if (!response.ok) { const payload = await response.json() as { error?: { message?: string } }; return payload.error?.message ?? t('console.backupRenameFailed'); }
      await refresh();
      return null;
    } catch { return t('console.backupRenameFailed'); } finally { setBusyAction(null); }
  };
  const deleteBackup = async () => {
    if (!deleteTarget) return;
    const backup = deleteTarget;
    setBusyAction(t('common.delete')); setError(null);
    try {
      const response = await apiFetch(`/api/v1/backups/${backup.id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { const payload = await response.json() as { error?: { message?: string } }; setError(payload.error?.message ?? t('console.backupDeleteFailed')); return; }
      if (selectedBackup?.id === backup.id) closeRestore();
      await refresh();
    } catch { setError(t('console.backupDeleteFailed')); } finally { setBusyAction(null); setDeleteOpen(false); }
  };
  const saveR2 = async (form: R2FormState): Promise<string | null> => {
    setR2Message(null);
    try {
      const response = await apiFetch('/api/v1/r2', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(form) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) return payload.error?.message ?? t('console.r2SaveFailed');
      setR2Config(payload.config); setR2Message(t('console.r2Saved')); await refresh();
      return null;
    } catch { return t('console.r2SaveFailed'); }
  };
  const testR2 = async () => {
    setR2Busy(t('console.r2Test')); setR2Message(null);
    try {
      const response = await apiFetch('/api/v1/r2/test', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { error?: { message?: string } };
      setR2Message(response.ok ? t('console.r2Tested') : payload.error?.message ?? t('console.r2TestFailed'));
    } catch { setR2Message(t('console.r2TestFailed')); } finally { setR2Busy(null); }
  };
  const uploadR2 = async () => {
    setR2Busy(t('console.r2UploadLatest')); setR2Message(null);
    setOperationProgress({ percent: 0, step: t('console.r2UploadLatest') });
    try {
      const response = await apiFetch('/api/v1/r2/sync', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { setR2Message(payload.error?.message ?? t('console.r2UploadFailed')); return; }
      // A first upload is gigabytes. It runs in the server and is followed the
      // same way a restore is, so the bar says how far it has got and the Stop
      // button reaches the work rather than only this page.
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      setR2Message(t('console.r2Uploaded')); await refresh();
    } catch (error: unknown) {
      setR2Message(error instanceof StoppedError ? null : error instanceof Error ? error.message : t('console.r2UploadFailed'));
    } finally { setR2Busy(null); setOperationProgress(null); setRunningJobId(null); }
  };
  /**
   * Bring one recovery point back as a local archive.
   *
   * It lands in the backup library rather than being written into the profile,
   * so restoring it is the same preview, the same safety snapshot and the same
   * merge-or-replace choice as any other archive - and the operator gets to
   * look at it first.
   */
  const fetchSnapshot = async (snapshot: R2SnapshotSummary) => {
    setR2Busy(t('console.r2Fetch')); setR2Message(null);
    setOperationProgress({ percent: 0, step: t('console.r2Fetch') });
    try {
      const response = await apiFetch(`/api/v1/r2/snapshots/${encodeURIComponent(snapshot.id)}/fetch`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { setR2Message(payload.error?.message ?? t('console.r2FetchFailed')); return; }
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      setR2Message(t('console.r2Fetched')); await refresh();
    } catch (error: unknown) {
      setR2Message(error instanceof StoppedError ? null : error instanceof Error ? error.message : t('console.r2FetchFailed'));
    } finally { setR2Busy(null); setOperationProgress(null); setRunningJobId(null); }
  };
  const reconcileR2 = async () => {
    setR2Busy(t('console.r2Reconcile')); setR2Message(null);
    try {
      const response = await apiFetch('/api/v1/r2/reconcile', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { collectedBlobs?: number; error?: { message?: string } };
      if (!response.ok) { setR2Message(payload.error?.message ?? t('console.r2ReconcileFailed')); return; }
      setR2Message(t('console.r2Reconciled')); await refresh();
    } catch { setR2Message(t('console.r2ReconcileFailed')); } finally { setR2Busy(null); }
  };
  const removeLegacy = async () => {
    setR2Busy(t('console.r2LegacyRemove')); setR2Message(null);
    try {
      const response = await apiFetch('/api/v1/r2/legacy', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { removed?: number; error?: { message?: string } };
      if (!response.ok) { setR2Message(payload.error?.message ?? t('console.r2LegacyRemoveFailed')); return; }
      setR2Message(t('console.r2LegacyRemoved')); await refresh();
    } catch { setR2Message(t('console.r2LegacyRemoveFailed')); } finally { setR2Busy(null); }
  };

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;
  const backupColumns: DataTableColumn<BackupManifest>[] = [
    { id: 'name', header: t('common.name'), sortable: true, cell: (backup) => <span className="font-medium">{backup.name}</span> },
    { id: 'source', header: t('console.backupSource'), sortable: true, showFrom: 'md', cell: (backup) => <span className="text-muted-foreground">{backup.source === 'uploaded' ? t('console.uploadedBackup') : t('console.createdBackup')}</span> },
    { id: 'createdAt', header: t('console.backupCreated'), sortable: true, showFrom: 'sm', cell: (backup) => <span className="whitespace-nowrap text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</span> },
    { id: 'sizeBytes', header: t('console.backupSize'), sortable: true, align: 'end', showFrom: 'sm', cell: (backup) => <span className="whitespace-nowrap text-muted-foreground">{formatBytes(backup.sizeBytes)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">{t('console.backupActions')}</span>,
      align: 'end',
      headClassName: 'w-12',
      cell: (backup) => <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('console.backupRowMenu')} disabled={busy}><Ellipsis /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void previewBackup(backup)}><RotateCcw />{t('console.restore')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { window.location.href = `/api/v1/backups/${backup.id}/download`; }}><Download />{t('console.downloadBackup')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenameTarget(backup)}><Pencil />{t('common.rename')}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => { setDeleteTarget(backup); setDeleteOpen(true); }}><Trash2 />{t('common.delete')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    },
  ];
  const snapshotColumns: DataTableColumn<R2SnapshotSummary>[] = [
    { id: 'createdAt', header: t('console.backupCreated'), sortable: true, cell: (snapshot) => <span className="whitespace-nowrap">{new Date(snapshot.createdAt).toLocaleString()}</span> },
    { id: 'indexBytes', header: t('console.backupSize'), sortable: true, align: 'end', showFrom: 'sm', cell: (snapshot) => <span className="whitespace-nowrap text-muted-foreground">{formatBytes(snapshot.indexBytes)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">{t('console.backupActions')}</span>,
      align: 'end',
      headClassName: 'w-24',
      cell: (snapshot) => <Button variant="ghost" size="sm" onClick={() => void fetchSnapshot(snapshot)} disabled={r2Busy !== null}><Download />{t('console.r2Fetch')}</Button>,
    },
  ];

  return <div className="grid min-w-0 gap-4">
    <Card>
      <PanelHeading icon={<UsersIcon />} action={<Button variant="outline" size="sm" onClick={() => setProfileOpen(true)} disabled={busy}><Plus />{t('console.newProfile')}</Button>}>{t('console.profilesTitle')}</PanelHeading>
      <CardContent>
        {activeProfile === null
          ? <EmptyState icon={<UsersIcon />} title={t('console.noProfiles')} />
          : <Field label={t('console.switchProfile')}>
            <Select value={activeProfile.id} onValueChange={(id) => void activate(id)} disabled={busy}>
              <SelectTrigger className="w-full sm:max-w-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>}
      </CardContent>
    </Card>

    <Card>
      <PanelHeading icon={<Archive />}>{t('console.backupLibrary')}</PanelHeading>
      <CardContent className="grid gap-4">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {busyAction ? <OperationProgress t={t} label={busyAction} progress={operationProgress} canStop={uploading || runningJobId !== null} stopping={stopping} onStop={() => void stopOperation()} warning={uploading ? t('console.uploadKeepTabOpen') : null} /> : null}
        <DataTable
          rows={backups}
          columns={backupColumns}
          rowKey={(backup) => backup.id}
          query={backupQuery}
          onQueryChange={setBackupQuery}
          labels={labels}
          searchText={backupSearchText}
          sortValue={backupSortValue}
          empty={<EmptyState icon={<Archive />} title={t('dashboard.noBackup')} />}
          toolbar={<div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <Button size="sm" onClick={() => setBackupOpen(true)} disabled={busy || activeProfileId === null}><Archive />{t('dashboard.backupNow')}</Button>
            <label className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer')}>
              <Upload aria-hidden="true" />{t('console.importZip')}
              <input type="file" accept=".zip,application/zip" className="sr-only" disabled={busy} onChange={(event) => void inspectUpload(event.target.files?.[0])} />
            </label>
          </div>}
        />
      </CardContent>
    </Card>

    <Card>
      <PanelHeading icon={<Cloud />} action={<Badge variant="outline" className={r2Config?.enabled ? 'status-online' : ''}>{r2Config?.enabled ? t('console.r2On') : t('console.r2Off')}</Badge>}>{t('console.r2Title')}</PanelHeading>
      <CardContent className="grid gap-4">
        <div>
          <DetailRow label={t('console.r2Connection')} hint={r2Config?.configured ? r2Config.bucket : t('console.r2SetupBody')}>
            <Button variant="outline" size="sm" onClick={() => setR2Open(true)}>{r2Config?.configured ? t('console.r2Change') : t('console.r2Configure')}</Button>
          </DetailRow>
          {r2Config?.configured ? <DetailRow label={t('console.r2LastUpload')} hint={r2Config.lastUploadAt ? new Date(r2Config.lastUploadAt).toLocaleString() : '—'}>
            <Button size="sm" onClick={() => void uploadR2()} disabled={r2Busy !== null}><Upload />{t('console.r2UploadLatest')}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('console.r2More')} disabled={r2Busy !== null}><Ellipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void testR2()}>{t('console.r2Test')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void reconcileR2()}>{t('console.r2Reconcile')}</DropdownMenuItem>
                {/* Backups taken under the old whole-file scheme. Nothing reads
                    them any more, but they are the operator's, so removing them
                    is asked for rather than assumed. */}
                {r2Config.usage.legacyObjectCount > 0
                  ? <DropdownMenuItem variant="destructive" onSelect={() => void removeLegacy()}><Trash2 />{t('console.r2LegacyRemove')} ({formatBytes(r2Config.usage.legacyBytes)})</DropdownMenuItem>
                  : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </DetailRow> : null}
        </div>
        {r2Message ? <Alert><AlertDescription>{r2Message}</AlertDescription></Alert> : null}
        {r2Busy ? <OperationProgress t={t} label={r2Busy} progress={operationProgress} canStop={runningJobId !== null} stopping={stopping} onStop={() => void stopOperation()} warning={null} /> : null}
        {r2Config?.configured ? <>
          <R2Usage t={t} config={r2Config} />
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">{t('console.r2Snapshots')}</h3>
            <DataTable
              rows={r2Snapshots}
              columns={snapshotColumns}
              rowKey={(snapshot) => snapshot.id}
              query={snapshotQuery}
              onQueryChange={setSnapshotQuery}
              labels={labels}
              sortValue={snapshotSortValue}
              pageSizes={[5, 10, 25]}
              empty={<EmptyState icon={<Cloud />} title={t('console.r2NoSnapshots')} description={t('console.r2FetchNote')} />}
            />
          </div>
        </> : null}
      </CardContent>
    </Card>

    <NameDialog
      t={t}
      open={profileOpen}
      onOpenChange={setProfileOpen}
      title={t('console.newProfile')}
      label={t('console.profileName')}
      hint={t('console.profileNameHint')}
      submitLabel={t('common.create')}
      onSubmit={createProfile}
    />
    <NameDialog
      t={t}
      open={backupOpen}
      onOpenChange={setBackupOpen}
      title={t('dashboard.backupNow')}
      label={t('common.name')}
      hint={t('console.backupNameHint')}
      submitLabel={t('dashboard.backupNow')}
      optional
      onSubmit={createBackup}
    />
    <NameDialog
      t={t}
      open={renameTarget !== null}
      onOpenChange={(next) => { if (!next) setRenameTarget(null); }}
      title={t('console.renameBackupTitle')}
      label={t('common.name')}
      initial={renameTarget?.name.replace(/\.zip$/u, '') ?? ''}
      submitLabel={t('common.rename')}
      onSubmit={renameBackup}
    />
    <ConfirmDialog
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
      title={t('console.deleteBackupTitle', { name: deleteTarget?.name ?? '' })}
      description={t('console.deleteBackupBody')}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      onConfirm={deleteBackup}
    />
    <RestoreDialog t={t} backup={selectedBackup} preview={selectedPreview} mode={restoreMode} onModeChange={setRestoreMode} onClose={closeRestore} onRestore={restoreSelected} />
    <R2Dialog t={t} open={r2Open} onOpenChange={setR2Open} config={r2Config} onSave={saveR2} />
  </div>;
}

/**
 * What is happening now, and the way to stop it.
 *
 * A backup, a restore, an import and a send to R2 all report the same way, so
 * one block says it rather than each card writing out its own bar, its own
 * percentage and its own Stop button in its own place.
 */
function OperationProgress({ t, label, progress, canStop, stopping, onStop, warning }: { t: Translate; label: string; progress: { percent: number; step: string } | null; canStop: boolean; stopping: boolean; onStop: () => void; warning: string | null }) {
  return <div className="grid gap-2 rounded-lg border bg-muted/40 p-3" role="status">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0 text-sm">{progress ? `${progress.step} · ${progress.percent}%` : label}</span>
      {canStop ? <Button variant="outline" size="sm" onClick={onStop} disabled={stopping}><CircleStop />{stopping ? t('console.stopping') : t('common.stop')}</Button> : null}
    </div>
    <span className="progress-track">{progress ? <span className="progress-value" style={{ width: `${Math.max(2, Math.min(100, progress.percent))}%` }} /> : <span className="progress-indeterminate" />}</span>
    {warning ? <span className="text-xs text-destructive">{warning}</span> : null}
  </div>;
}

/**
 * One field, and the button that uses it.
 *
 * Naming a new profile, naming a backup and renaming one are the same question
 * asked three times. None of them is `window.prompt` any more, which could not
 * be translated, could not be styled, and asked in the browser's voice rather
 * than this program's.
 */
function NameDialog({ t, open, onOpenChange, title, label, hint, initial = '', submitLabel, optional = false, onSubmit }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; title: string; label: string; hint?: string; initial?: string; submitLabel: string; optional?: boolean; onSubmit: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog stays mounted, so what was typed last time is cleared on the way
  // in rather than on the way out: a rename has to open on the name of the row
  // that was actually pressed.
  useEffect(() => { if (open) { setName(initial); setError(null); } }, [open, initial]);
  const ready = optional || name.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      const failure = await onSubmit(name.trim());
      setError(failure);
      if (!failure) onOpenChange(false);
    } finally { setBusy(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody className="grid gap-4">
        <Field label={label} hint={hint}>
          <Input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} autoComplete="off" />
        </Field>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => void submit()} disabled={busy || !ready}>{submitLabel}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * The one question a restore has to answer before it runs.
 *
 * What happens to the data already in the profile used to be a dropdown
 * labelled "Restore mode" holding the words "Replace" and "Merge", sitting on
 * the page beside a button that did it. The two outcomes are written out now
 * where the choice is made, and the choice is made in a dialog, because one of
 * them deletes everything that is there.
 */
function RestoreDialog({ t, backup, preview, mode, onModeChange, onClose, onRestore }: { t: Translate; backup: BackupManifest | null; preview: RestorePreview | null; mode: RestoreMode; onModeChange: (mode: RestoreMode) => void; onClose: () => void; onRestore: () => Promise<void> }) {
  const group = useId();
  if (!backup || !preview) return null;
  const options: Array<{ value: RestoreMode; label: string; body: string }> = [
    { value: 'replace', label: t('console.replaceRestore'), body: t('console.restoreReplaceBody') },
    { value: 'merge', label: t('console.mergeRestore'), body: t('console.restoreMergeBody') },
  ];
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('console.restoreTitle', { name: backup.name })}</DialogTitle>
        <DialogDescription>{t('console.restoreCounts', { files: preview.fileCount, size: formatBytes(preview.totalBytes) })}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <RadioGroup value={mode} onValueChange={(value) => onModeChange(value as RestoreMode)} aria-label={t('console.restoreChoose')}>
          {options.map((option) => <div key={option.value} className="flex items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
            <RadioGroupItem id={`${group}-${option.value}`} value={option.value} className="mt-0.5" />
            <div className="grid gap-1">
              <Label htmlFor={`${group}-${option.value}`} className="font-medium">{option.label}</Label>
              <p className="text-xs text-muted-foreground">{option.body}</p>
            </div>
          </div>)}
        </RadioGroup>
        {preview.warnings.length > 0 ? <Alert><AlertDescription>{preview.warnings.join(' ')}</AlertDescription></Alert> : null}
        <p className="text-xs text-muted-foreground">{t('console.restoreSafety')}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant={mode === 'replace' ? 'destructive' : 'default'} onClick={() => void onRestore()}>{t('console.restoreStart')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * Where the off-machine copy goes, behind one button.
 *
 * Eleven settings used to sit open on the page, which is eleven things to read
 * past for everyone who has no bucket and is never going to get one. They are
 * here now, split into the part that says where the data goes and the part that
 * says how often.
 */
function R2Dialog({ t, open, onOpenChange, config, onSave }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; config: R2Config | null; onSave: (form: R2FormState) => Promise<string | null> }) {
  const [form, setForm] = useState<R2FormState>(() => r2FormFrom(config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabledId = useId();
  useEffect(() => { if (open) { setForm(r2FormFrom(config)); setError(null); } }, [open, config]);
  const set = (patch: Partial<R2FormState>) => setForm((current) => ({ ...current, ...patch }));
  const number = (value: string, fallback: number) => { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? parsed : fallback; };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onSave(form);
      setError(failure);
      if (!failure) onOpenChange(false);
    } finally { setBusy(false); }
  };

  const schedule: Array<{ label: string; value: number; apply: (value: number) => Partial<R2FormState>; min: number }> = [
    { label: t('console.r2LocalEvery'), value: form.localIntervalMinutes, apply: (value) => ({ localIntervalMinutes: value }), min: 1 },
    { label: t('console.r2HotEvery'), value: form.hotIntervalMinutes, apply: (value) => ({ hotIntervalMinutes: value }), min: 1 },
    { label: t('console.r2ColdEvery'), value: form.coldIntervalHours, apply: (value) => ({ coldIntervalHours: value }), min: 1 },
    { label: t('console.r2KeepRecent'), value: form.keepRecent, apply: (value) => ({ keepRecent: value }), min: 1 },
    { label: t('console.r2KeepDaily'), value: form.keepDaily, apply: (value) => ({ keepDaily: value }), min: 0 },
    { label: t('console.r2KeepWeekly'), value: form.keepWeekly, apply: (value) => ({ keepWeekly: value }), min: 0 },
  ];

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('console.r2Title')}</DialogTitle>
        <DialogDescription>{t('console.r2SetupBody')}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Tabs defaultValue="connection">
          <TabsList className="w-full">
            <TabsTrigger value="connection" className="flex-1">{t('console.r2Connection')}</TabsTrigger>
            <TabsTrigger value="schedule" className="flex-1">{t('console.r2Schedule')}</TabsTrigger>
          </TabsList>
          <TabsContent value="connection" className="grid gap-4 pt-4">
            <Field label={t('console.r2Endpoint')}><Input value={form.endpoint} onChange={(event) => set({ endpoint: event.target.value })} placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com" autoComplete="off" /></Field>
            <Field label={t('console.r2Bucket')}><Input value={form.bucket} onChange={(event) => set({ bucket: event.target.value })} autoComplete="off" /></Field>
            <Field label={t('console.r2AccountId')}><Input value={form.accountId} onChange={(event) => set({ accountId: event.target.value })} autoComplete="off" /></Field>
            <Field label={t('console.r2AccessKey')}><Input value={form.accessKeyId} onChange={(event) => set({ accessKeyId: event.target.value })} autoComplete="off" /></Field>
            <Field label={t('console.r2SecretKey')}><PasswordInput revealLabel={t('setup.reveal')} hideLabel={t('setup.hide')} value={form.secretAccessKey} onChange={(event) => set({ secretAccessKey: event.target.value })} autoComplete="new-password" /></Field>
          </TabsContent>
          <TabsContent value="schedule" className="grid gap-4 pt-4 sm:grid-cols-2">
            {schedule.map((row) => <Field key={row.label} label={row.label}>
              <Input type="number" min={row.min} value={row.value} onChange={(event) => set(row.apply(number(event.target.value, row.value)))} />
            </Field>)}
          </TabsContent>
        </Tabs>
        {error ? <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter className="sm:justify-between">
        <div className="flex items-center gap-2">
          <Switch id={enabledId} checked={form.enabled} onCheckedChange={(checked) => set({ enabled: checked })} />
          <Label htmlFor={enabledId}>{t('console.r2Enabled')}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={busy}>{t('common.save')}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * What the bucket is holding, against what it is allowed to hold.
 *
 * The point of the whole incremental design is that a free account stays free,
 * and the operator cannot check that from the number of files. Two bars say it
 * directly: how full the storage is, and how much of the month's charged writes
 * have gone. Both turn to the attention colour before they are reached, not
 * after - a backup that has already refused is too late to be a warning.
 */
function R2Usage({ t, config }: { t: Translate; config: R2Config }) {
  const bars: Array<{ label: string; text: string; filled: number }> = [
    { label: t('console.r2Estimate'), text: `${formatBytes(config.usage.storageBytes)} / ${formatBytes(config.limits.maxStorageBytes)}`, filled: ratio(config.usage.storageBytes, config.limits.maxStorageBytes) },
    { label: t('console.r2Writes'), text: `${config.usage.writeOperations.toLocaleString()} / ${config.limits.maxWriteOperations.toLocaleString()}`, filled: ratio(config.usage.writeOperations, config.limits.maxWriteOperations) },
    // Reads are what a restore costs. They are reported but never enforced:
    // refusing someone their data back to avoid a small bill is the wrong way
    // round.
    { label: t('console.r2Reads'), text: `${config.usage.readOperations.toLocaleString()} / ${config.limits.maxReadOperations.toLocaleString()}`, filled: ratio(config.usage.readOperations, config.limits.maxReadOperations) },
  ];
  return <div className="grid gap-3">
    {bars.map((bar) => <div className="grid gap-1" key={bar.label}>
      <span className={cn('text-xs', bar.filled >= 0.9 ? 'text-destructive' : 'text-muted-foreground')}>{bar.label}: {bar.text}</span>
      <span className="progress-track"><span className="progress-value" style={{ width: `${Math.max(1, bar.filled * 100)}%` }} /></span>
    </div>)}
  </div>;
}

function ratio(value: number, limit: number): number {
  return limit > 0 ? Math.max(0, Math.min(1, value / limit)) : 0;
}


function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function SystemPanel({ t, csrfToken }: { t: Translate; csrfToken: string }) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const remeasure = async () => {
    try {
      const response = await apiFetch('/api/v1/system/measure', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (response.ok) setSnapshot(await response.json() as SystemSnapshot);
    } catch {
      // The next poll reports the sizes whether or not this request landed.
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await apiFetch('/api/v1/system', { credentials: 'same-origin', signal: controller.signal });
        if (response.ok && !controller.signal.aborted) setSnapshot(await response.json() as SystemSnapshot);
      } catch {
        // A dropped reading is replaced by the next one.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  const rows: Array<{ key: string; label: string; value: string; ratio?: number }> = [];
  if (snapshot) {
    const { cpu, memory, storage } = snapshot;
    rows.push({
      key: 'cpu',
      label: t('system.cpu'),
      value: `${cpu.usagePercent === null ? '—' : `${cpu.usagePercent}%`} · ${cpu.cores} ${t('system.cores')}`,
      ...(cpu.usagePercent === null ? {} : { ratio: cpu.usagePercent / 100 }),
    });
    rows.push({
      key: 'memory',
      label: t('system.memory'),
      value: `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
      ratio: memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0,
    });
    if (storage.totalBytes !== null && storage.freeBytes !== null) {
      const used = storage.totalBytes - storage.freeBytes;
      rows.push({
        key: 'disk',
        label: t('system.disk'),
        value: `${formatBytes(storage.freeBytes)} ${t('system.free')} / ${formatBytes(storage.totalBytes)}`,
        ratio: storage.totalBytes > 0 ? used / storage.totalBytes : 0,
      });
    }
    rows.push({
      key: 'managerBytes',
      label: t('system.managerFootprint'),
      value: storage.managerBytes === null ? t('system.measuring') : formatBytes(storage.managerBytes),
    });
    rows.push({
      key: 'dataBytes',
      label: t('system.activeData'),
      value: storage.dataBytes === null
        ? t('system.measuring')
        : `${formatBytes(storage.dataBytes)}${storage.dataFileCount === null ? '' : ` · ${storage.dataFileCount.toLocaleString()} ${t('console.files')}`}`,
    });
  }

  return <Card data-tour="system"><PanelHeading icon={<Cpu />}>{t('system.title')}</PanelHeading><CardContent className="flex-1">
    {snapshot ? <dl className="system-list">{rows.map((row) => <div key={row.key}>
      <dt>{row.label}</dt>
      <dd>
        <span>{row.value}</span>
        {row.ratio === undefined ? null : <span className="system-track"><span className="system-value" style={{ width: `${Math.round(Math.max(0, Math.min(1, row.ratio)) * 100)}%` }} /></span>}
      </dd>
    </div>)}</dl> : <p className="resource-empty">{t('common.loading')}</p>}
    {snapshot ? <p className="system-note">
      {snapshot.storage.measuredAt ? <span>{t('system.sizesMeasuredAt')} {new Date(snapshot.storage.measuredAt).toLocaleTimeString()}</span> : <span />}
      <Button variant="ghost" size="sm" onClick={() => void remeasure()} disabled={snapshot.storage.measuring}><RefreshCw />{snapshot.storage.measuring ? t('system.measuring') : t('system.remeasure')}</Button>
    </p> : null}
  </CardContent></Card>;
}

function MetricsPage({ t }: { t: Translate }) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [days, setDays] = useState(30);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await apiFetch(`/api/v1/metrics?days=${days}`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('metrics request failed');
        const payload = await response.json() as MetricsSnapshot;
        if (!cancelled) { setSnapshot(payload); setError(false); }
      } catch { if (!cancelled) setError(true); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [days, refresh]);
  return <div className="metrics-workspace">
    <div className="metrics-toolbar">
      <div className="metrics-segments" role="group" aria-label={t('console.metricsPeriod')}>
        {([7, 30, 90] as const).map((value) => <button key={value} type="button" aria-pressed={days === value} onClick={() => { if (days !== value) { setSnapshot(null); setDays(value); } }}>{value} {t('console.metricsDays')}</button>)}
      </div>
      <Button variant="ghost" size="icon" aria-label={t('common.refresh')} onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button>
    </div>
    {error ? <p className="text-sm text-destructive" role="alert">{t('console.metricsLoadFailed')}</p> : null}
    {!snapshot ? <Card className="resource-panel"><CardContent className="resource-empty"><p>{t(error ? 'console.metricsLoadFailed' : 'common.loading')}</p></CardContent></Card> : <>
    <div className="metrics-summary-grid">
      <MetricValue icon={<BarChart3 />} label={t('console.metricRequests')} value={snapshot.totals.requests.toLocaleString()} />
      <TokenMetricCard t={t} totals={snapshot.totals} />
      <MetricValue icon={<Database />} label={t('console.metricCacheHit')} value={formatMetricRate(snapshot.totals.cacheHitRate)} {...(snapshot.totals.cacheObservedRequests > 0 ? { subtitle: `${snapshot.totals.cacheObservedRequests.toLocaleString()} ${t('console.metricCacheRequests')}` } : {})} />
      <MetricValue icon={<Clock3 />} label={t('console.metricLatency')} value={metricDuration(snapshot.totals.averageLatencyMs)} />
    </div>
    <TrendChart t={t} daily={snapshot.daily} to={snapshot.range.to} days={days} />
    <div className="metrics-tables">
      <MetricsTable t={t} title={t('console.metricProviders')} rows={snapshot.providers} maxRequests={snapshot.totals.requests} />
      <MetricsTable t={t} title={t('console.metricModels')} rows={snapshot.models} maxRequests={snapshot.totals.requests} />
    </div>
    </>}
  </div>;
}

function MetricValue({ icon, label, value, subtitle }: { icon: ReactNode; label: string; value: string; subtitle?: string }) {
  return <Card className="metric-value"><CardContent><div className="metric-value-label">{icon}<span>{label}</span></div><div className="metric-value-number"><strong>{value}</strong>{subtitle ? <small>{subtitle}</small> : null}</div></CardContent></Card>;
}

function TokenMetricCard({ t, totals }: { t: Translate; totals: MetricsSnapshot['totals'] }) {
  const total = totals.totalTokens.toLocaleString();
  const input = totals.inputTokens.toLocaleString();
  const output = totals.outputTokens.toLocaleString();
  return <Card className="metric-value metric-token-card"><CardContent>
    <div className="metric-token-topline"><div className="metric-value-label"><Database /><span>{t('console.metricTokens')}</span></div><TokenDetails t={t} values={totals} /></div>
    <strong className="metric-token-total" title={total}>{total}</strong>
    <div className="token-pair"><span title={`${t('console.metricInput')}: ${input}`} aria-label={t('console.metricInput')}><ArrowDown /><b>{input}</b></span><span title={`${t('console.metricOutput')}: ${output}`} aria-label={t('console.metricOutput')}><ArrowUp /><b>{output}</b></span></div>
  </CardContent></Card>;
}

function TokenDetails({ t, values }: { t: Translate; values: Pick<MetricsSnapshot['totals'], 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheObservedRequests' | 'reasoningTokens' | 'streamRequests'> }) {
  return <details className="token-details"><summary title={t('console.metricBreakdown')} aria-label={t('console.metricBreakdown')}><Ellipsis /></summary><dl className="token-details-grid">
    <div><dt><ArrowDown />{t('console.metricCacheRead')}</dt><dd>{values.cacheObservedRequests === 0 ? '—' : values.cacheReadTokens.toLocaleString()}</dd></div>
    <div><dt><ArrowUp />{t('console.metricCacheWrite')}</dt><dd>{values.cacheObservedRequests === 0 ? '—' : values.cacheWriteTokens.toLocaleString()}</dd></div>
    <div><dt><BrainCircuit />{t('console.metricReasoning')}</dt><dd>{values.reasoningTokens.toLocaleString()}</dd></div>
    <div><dt><ArrowUpRight />{t('console.metricStreaming')}</dt><dd>{values.streamRequests.toLocaleString()}</dd></div>
  </dl></details>;
}

function TrendChart({ t, daily, to, days }: { t: Translate; daily: readonly MetricsSnapshot['daily'][number][]; to: string; days: number }) {
  const [measure, setMeasure] = useState<'requests' | 'totalTokens'>('requests');
  const [selected, setSelected] = useState<string | null>(null);
  const byDay = new Map(daily.map((bucket) => [bucket.key, bucket]));
  const end = new Date(to.slice(0, 10));
  const series = Array.from({ length: days }, (_, index) => {
    const key = new Date(end.getTime() - (days - index - 1) * 86_400_000).toISOString().slice(0, 10);
    const bucket = byDay.get(key);
    return { key, requests: bucket?.requests ?? 0, totalTokens: bucket?.totalTokens ?? 0 };
  });
  const maximum = Math.max(1, ...series.map((bucket) => bucket[measure]));
  const scale = maximum <= 4 ? maximum : Math.ceil(maximum / 4) * 4;
  const ticks = scale < 4 ? Array.from({ length: scale + 1 }, (_, i) => i) : [0, scale / 4, scale / 2, scale * .75, scale];
  const width = 880; const height = 250; const pad = { top: 12, right: 24, bottom: 30, left: 52 };
  const plotWidth = width - pad.left - pad.right; const plotHeight = height - pad.top - pad.bottom;
  const xFor = (index: number) => pad.left + index * plotWidth / (series.length - 1);
  const yFor = (value: number) => pad.top + plotHeight * (1 - value / scale);
  const points = series.map((bucket, index) => `${xFor(index)},${yFor(bucket[measure])}`).join(' ');
  const selection = series.find((bucket) => bucket.key === selected) ?? series.at(-1)!;
  return <Card className="metrics-chart-card">
    <CardHeader><div className="metrics-chart-heading"><h2 className="panel-title">{t('console.metricActivity')}</h2><div className="metrics-segments" role="group" aria-label={t('console.metricActivity')}>
      <button type="button" aria-pressed={measure === 'requests'} onClick={() => setMeasure('requests')}>{t('console.metricRequests')}</button>
      <button type="button" aria-pressed={measure === 'totalTokens'} onClick={() => setMeasure('totalTokens')}>{t('console.metricTokens')}</button>
    </div></div></CardHeader>
    <CardContent>
      <div className="trend-selection" aria-live="polite"><time dateTime={selection.key}>{new Date(selection.key).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}</time><strong>{selection[measure].toLocaleString()}</strong><span>{t(measure === 'requests' ? 'console.metricRequestsShort' : 'console.metricTokens')}</span></div>
      {daily.length === 0 ? <p className="metrics-empty">{t('console.noMetrics')}</p> : <div className="metrics-chart-shell">
        <svg className="metrics-chart-svg" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t('console.metricActivity')}>
          {ticks.map((value) => <g key={value}><line x1={pad.left} x2={width - pad.right} y1={yFor(value)} y2={yFor(value)} className="trend-grid-line" /><text x={pad.left - 10} y={yFor(value) + 4} textAnchor="end" className="trend-axis-label">{metricCompact(value)}</text></g>)}
          <polygon points={`${pad.left},${yFor(0)} ${points} ${width - pad.right},${yFor(0)}`} className="trend-area" />
          <polyline points={points} className="trend-line trend-line-request" />
          {series.map((bucket, index) => <g key={bucket.key}>
            {bucket.key === selection.key ? <line x1={xFor(index)} x2={xFor(index)} y1={pad.top} y2={yFor(0)} className="trend-cursor" /> : null}
            {bucket[measure] > 0 ? <circle cx={xFor(index)} cy={yFor(bucket[measure])} r="3" className="trend-point trend-point-request" /> : null}
            {index === 0 || index === days - 1 || index % Math.ceil(days / 5) === 0 ? <text x={xFor(index)} y={height - 5} textAnchor="middle" className="trend-axis-label">{bucket.key.slice(5).replace('-', '/')}</text> : null}
            <rect x={xFor(index) - plotWidth / (days - 1) / 2} y={pad.top} width={plotWidth / (days - 1)} height={plotHeight} fill="transparent" tabIndex={0} role="button" aria-label={`${bucket.key}: ${bucket[measure]} ${t(measure === 'requests' ? 'console.metricRequestsShort' : 'console.metricTokens')}`} onPointerEnter={() => setSelected(bucket.key)} onFocus={() => setSelected(bucket.key)} onClick={() => setSelected(bucket.key)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(bucket.key); } }} />
          </g>)}
        </svg>
      </div>}
    </CardContent>
  </Card>;
}

function metricCompact(value: number): string { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function metricDuration(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`; }
function formatMetricRate(value: number | null): string { return value === null ? '—' : `${(value * 100).toFixed(1)}%`; }

function MetricsTable({ t, title, rows, maxRequests }: { t: Translate; title: string; rows: readonly MetricsSnapshot['providers'][number][]; maxRequests: number }) {
  return <Card className="metrics-table-card"><CardHeader><div className="metrics-chart-heading"><div className="metric-value-label"><BarChart3 /><span>{title}</span></div><span className="metrics-count">{rows.length}</span></div></CardHeader><CardContent>{rows.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : <div className="metrics-table" role="table">{rows.slice(0, 8).map((row, index) => <div className="metrics-table-row" role="row" key={row.key}><div className="metrics-rank">{index + 1}</div><div className="metrics-rank-main"><div className="metrics-rank-top"><div className="metrics-rank-name"><strong title={row.key}>{row.key}</strong>{row.completionSource ? <small>{row.completionSource}</small> : null}</div><span>{maxRequests > 0 ? `${Math.round((row.requests / maxRequests) * 100)}%` : '0%'}</span></div><div className="metrics-rank-bar"><i style={{ width: `${maxRequests > 0 ? Math.max(3, (row.requests / maxRequests) * 100) : 0}%` }} /></div><div className="metrics-rank-meta"><span>{row.requests.toLocaleString()} {t('console.metricRequestsShort')}</span><TokenSummary t={t} values={row} /></div></div></div>)}</div>}</CardContent></Card>;
}

function TokenSummary({ t, values }: { t: Translate; values: MetricsSnapshot['providers'][number] }) {
  return <div className="token-summary"><span title={t('console.metricInput')}><ArrowDown />{values.inputTokens.toLocaleString()}</span><span title={t('console.metricOutput')}><ArrowUp />{values.outputTokens.toLocaleString()}</span><TokenDetails t={t} values={values} /></div>;
}

function ConfigPage({ t, config, onConfigUpdate, onChangeManagerPassword }: { t: Translate; config: ConfigDocument | null; onConfigUpdate: (input: ConfigUpdateInput) => Promise<string | null>; onChangeManagerPassword: (password: string, confirmPassword: string) => Promise<string | null> }) {
  const [form, setForm] = useState({ sslEnabled: false, enableCorsProxy: false, disableCsrfProtection: false });
  const [rawYaml, setRawYaml] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [managerPasswordOpen, setManagerPasswordOpen] = useState(false);
  const { toast } = useToast();
  useEffect(() => {
    if (!config) return;
    setForm({ sslEnabled: config.settings.sslEnabled, enableCorsProxy: config.settings.enableCorsProxy, disableCsrfProtection: config.settings.disableCsrfProtection });
    setRawYaml(config.rawYaml);
  }, [config]);
  const save = async (input: ConfigUpdateInput) => { setBusy(true); setMessage(null); try { const error = await onConfigUpdate(input); setMessage(error ?? t('console.configSaved')); } finally { setBusy(false); } };
  const saveCommon = () => void save({ settings: { sslEnabled: form.sslEnabled, enableCorsProxy: form.enableCorsProxy, disableCsrfProtection: form.disableCsrfProtection } });
  const saveManagerPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const error = await onChangeManagerPassword(password, confirmPassword);
    if (!error) toast({ title: t('console.managerPasswordSaved'), tone: 'success' });
    return error;
  };
  return <div className="config-workspace">
    <div className="config-heading"><div><h2>{t('console.configTitle')}</h2></div>{config ? <Badge variant="outline">{config.runtimeRef}</Badge> : null}</div>
    <Card className="config-card">
      <CardHeader><h3 className="panel-title"><UsersIcon />{t('console.managerPasswordTitle')}</h3></CardHeader>
      <CardContent><div className="access-row"><div><strong>{t('console.managerPasswordHint')}</strong></div><Button variant="outline" size="sm" onClick={() => setManagerPasswordOpen(true)}>{t('console.changePassword')}</Button></div></CardContent>
    </Card>
    <PasswordDialog t={t} open={managerPasswordOpen} onOpenChange={setManagerPasswordOpen} title={t('console.managerPasswordTitle')} description={t('console.managerPasswordHint')} note={t('console.passwordChangeSignsOut')} minLength={MIN_MANAGER_PASSWORD} hint={t('console.managerPasswordMin')} submitLabel={t('console.changePassword')} onSubmit={saveManagerPassword} />
    {!config ? <Card className="resource-panel"><CardContent className="resource-empty"><p>{t('console.noConfiguration')}</p></CardContent></Card> : <>
      <Card className="config-card"><CardHeader><h3 className="panel-title"><Settings2 />{t('console.commonSettings')}</h3><p className="config-path">{config.path}</p></CardHeader><CardContent className="config-form-grid"><label className="config-toggle"><span><strong>{t('console.ssl')}</strong><small>{t('console.sslHint')}</small></span><Switch checked={form.sslEnabled} onCheckedChange={(value) => setForm((current) => ({ ...current, sslEnabled: value }))} /></label><label className="config-toggle"><span><strong>{t('console.corsProxy')}</strong><small>{t('console.corsProxyHint')}</small></span><Switch checked={form.enableCorsProxy} onCheckedChange={(value) => setForm((current) => ({ ...current, enableCorsProxy: value }))} /></label><label className="config-toggle"><span><strong>{t('console.disableCsrf')}</strong><small>{t('console.disableCsrfHint')}</small></span><Switch checked={form.disableCsrfProtection} onCheckedChange={(value) => setForm((current) => ({ ...current, disableCsrfProtection: value }))} /></label><div className="config-fixed"><span>{t('console.port')}</span><strong>8000</strong></div></CardContent><CardFooter className="config-actions"><span className="config-restart-note">{t('console.restartAfterSave')}</span><Button onClick={saveCommon} disabled={busy}>{t('common.save')}</Button></CardFooter></Card><Card className="config-card"><CardHeader><h3 className="panel-title"><ScrollText />{t('console.rawYaml')}</h3></CardHeader><CardContent><textarea className="config-editor" value={rawYaml} onChange={(event) => setRawYaml(event.target.value)} spellCheck={false} aria-label={t('console.rawYaml')} /></CardContent><CardFooter className="config-actions"><span className={message?.startsWith('Could') ? 'install-error' : 'config-restart-note'} role="status">{message ?? t('console.rawYamlHint')}</span><Button variant="outline" onClick={() => void save({ rawYaml })} disabled={busy}>{t('console.applyYaml')}</Button></CardFooter></Card>
    </>}
  </div>;
}

function ResourcePanel({ page, t }: { page: Exclude<PageId, 'overview' | 'data'>; t: Translate }) {
  const emptyMessage = { metrics: 'console.noMetrics', config: 'console.noConfiguration' } as const;
  return <Card className="resource-panel"><CardContent className="resource-empty"><p>{t(emptyMessage[page])}</p></CardContent></Card>;
}
