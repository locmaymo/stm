import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { centralDirectoryOffset, ZIP_TAIL_SEARCH_BYTES } from './zip-tail.js';
import {
  AppWindow, Archive, ArrowDown, ArrowRight, CloudUpload, DatabaseBackup, Funnel, UserRound, ArrowUp, ArrowUpRight, BarChart3, Check, ChevronDown, Cloud, Copy, Database, Download,
  Globe2, LayoutDashboard, Maximize2, Minimize2, Moon, Package, Pencil, Plus,
  LogOut, RotateCcw, ScrollText, Search, Sun, Trash2, Upload, X, Rows3,
  BrainCircuit, CircleStop, Clock3, Cpu, Ellipsis, Play, QrCode as QrCodeIcon, RefreshCw, Scale, Settings2, ShieldCheck, Square,
  Blocks, BookmarkPlus, Bug, FileCode2, LoaderCircle, Gauge, History, KeyRound, Leaf, Monitor, CircleArrowUp, Star, TriangleAlert,
} from 'lucide-react';
import {
  Alert, AlertDescription, AlertTitle, AuthLayout, Badge, BrandMark, Button, ButtonGroup, ButtonGroupSeparator, buttonVariants, Card, CardAction,
  ConfirmDialog, DetailRow, EmptyState, StatTile, type StatusTone,
  CardContent, CardFooter, CardHeader,
  CardGrid, Checkbox, cn, DataTable, type DataTableColumn, type DataTableLabels,
  Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Field, GithubMark, initialQuery, Input, Label, MobileNav, PageContainer, PasscodeInput, PasswordInput, Textarea,
  Skeleton,
  RadioGroup, RadioGroupItem,
  Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue,
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarTrigger, Sheet, SheetContent, SheetHeader, SheetTitle, Switch,
  Tabs, TabsContent, TabsList, TabsTrigger, type TableQuery, Toaster, Tooltip,
  TooltipContent, TooltipTrigger, useSidebar, useToast,
} from '../../../packages/ui/src/index.js';
import { failures, logCatalog, translator, type Fail, type MessageKey, type Translate } from './i18n.js';
import { browserEnvironment, browserStorage, readPreferences, savePreferences, type LocaleCode, type Preferences } from './preferences.js';
import { authErrorKey } from './auth-error.js';
import { DEFAULT_SILLYTAVERN_PORT, portRefusal } from './ports.js';
import { isThisMachine, readAddressOfferAnswered, readOwnLinkWanted, saveAddressOfferAnswered, saveOwnLinkWanted, shouldOfferPlatformAddress } from './hosting.js';
import { availableUpdate, readDismissedManagerRelease, readDismissedUpdate, saveDismissedManagerRelease, saveDismissedUpdate, shouldShowManagerRelease } from './updates.js';
import { readDismissedDisplaced, readDismissedRecovery, readDismissedSettings, saveDismissedDisplaced, saveDismissedRecovery, saveDismissedSettings, shouldOfferSettings, shouldShowDisplaced, shouldShowRecovery } from './settings-offer.js';
import { apiFetch, onSessionExpired, resetSessionWatch, sessionToken, setSessionToken } from './session.js';
import { collectCloudflareResult, framed, openReturnWindow, popupsBlocked, whenAbandoned, type CollectedResult } from './oauth.js';
import type { AccessGatewayState, BackupManifest, CloudflareAccountProblem, ConfigDocument, ConsoleStatus, ConfigSettings, ConfigSettingsInput, ConfigUpdateInput, Installation, Job, LocalBackupSchedule, LegalReview, LogEntry, LogSourceFilter, ManagerRelease, ManagerSettingsOffer, ManagerUpdateStatus, OnlineState, MetricsBucket, SetupStatus, MetricsSnapshot, PortSettings, ProcessState, Profile, R2CheckResult, R2CloudflareUsage, R2Config, R2ConnectionMode, R2SnapshotSummary, R2UsageResponse, R2UsageWarning, RestoreMode, RestorePreview, SaverState, SetupChecklistState, SetupStep, StartupSettings, StorageDurabilityReport, SystemSnapshot, TunnelState, VersionOption } from '../../../packages/contracts/src/index.js';
import { BACKUP_KINDS, backupKind, backupSearchText, backupSortValue, formatBytes, isCloudJob, type BackupKind, metricsSearchText, metricsSortValue, snapshotSortValue } from '../../../packages/contracts/src/index.js';
import { useLiveLogs } from './use-live-logs.js';
import { usePoll } from './use-poll.js';
import { POLL_BACKGROUND_MS, POLL_RELEASE_MS, statusIntervalMs } from './polling.js';
import { foldForSearch, translateLogEntry, translateStep } from '../../../packages/contracts/src/index.js';
import { QrCode } from './qr-code.js';
import { CLOUDFLARE_ORANGE, CloudflareMark } from './cloudflare-mark.js';
import { bareHost, localHost, publicAddress, reachableAddresses, shortenHost } from './addresses.js';
import { EmbedStage } from './embed-stage.js';
import { SetupChecklist, type ChecklistItem } from './setup-checklist.js';
import { LegalCredit, LegalDialog, LEGAL_REVISION } from './legal-dialog.js';
import { legalBundle, legalRevision, type LegalDocumentId } from '../../../packages/legal/src/index.js';

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
/**
 * The passcode that opens SillyTavern from outside this machine.
 *
 * Six digits rather than a password, because the public address is a
 * `trycloudflare.com` subdomain and a browser shown a password typed into one of
 * those warns the reader, in red, that they may have handed it to a phishing
 * site. The door is worth less entropy than a password, so the gateway locks
 * globally after five consecutive wrong tries rather than only per address -
 * the trade a phone makes, for the same reason.
 */
const PASSCODE_DIGITS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const UPLOAD_RETRIES = 3;
const UPLOAD_RATE_WINDOW_MS = 10_000;

/**
 * What to say about a reply that was not the JSON this panel expected.
 *
 * An upload passes through whatever sits in front of the manager, and a proxy
 * that gives up answers in its own voice - its own JSON, or an HTML error
 * page. The manager's own refusal is translated; the proxy's words are its
 * own; and a reply with nothing in it at all leaves only the status code.
 */
function apiErrorFromText(text: string, status: number, fallback: string, fail: Fail, proxyHtml: string): string {
  try {
    const payload: unknown = JSON.parse(text);
    const proxyMessage = isRecord(payload) && typeof payload.Message === 'string' ? payload.Message : null;
    return fail.body(payload, proxyMessage ?? `${fallback} (HTTP ${status})`);
  } catch {
    const looksLikeHtml = /<!doctype\s+html|<html[\s>]/iu.test(text);
    return looksLikeHtml
      ? proxyHtml
      : `${fallback} (HTTP ${status})`;
  }
}

/** Thrown when the operator stops the work themselves, which is not an error. */
class StoppedError extends Error {
  public constructor() { super('stopped'); this.name = 'StoppedError'; }
}

/** A stopped restore that could not be put back, so the profile is left mixed. */
class RollbackFailedError extends Error {
  public constructor(message: string) { super(message); this.name = 'RollbackFailedError'; }
}

/** What a failed chunk should say, in the reader's language rather than this file's. */
interface UploadMessages {
  readonly fail: Fail;
  readonly failed: string;
  readonly proxyPage: string;
}

async function uploadChunkWithRetry(url: string, body: Blob, headers: HeadersInit, messages: UploadMessages, signal?: AbortSignal): Promise<unknown> {
  let lastError = messages.failed;
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
    if (response.ok) return await response.json().catch(() => null) as unknown;
    const text = await response.text();
    lastError = apiErrorFromText(text, response.status, messages.failed, messages.fail, messages.proxyPage);
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
  /*
   * Whether the session that is open was opened by setting the password for
   * the first time, rather than by signing in.
   *
   * It is the one moment where offering a Cloudflare account is not an
   * interruption: nothing has been set up yet, there is nothing to lose, and
   * connecting now is what makes the machine's data outlive the machine - and
   * what makes a machine set up on this account before hand everything back.
   */
  const [firstRun, setFirstRun] = useState(false);
  /**
   * Whether this manager can be opened with a Cloudflare account, and whose it
   * already is.
   *
   * Null until the first answer, and on a build with no OAuth client at all -
   * both of which mean the screen shows the password field and nothing else.
   */
  const [cloudflareSignIn, setCloudflareSignIn] = useState<SetupStatus['cloudflareSignIn'] | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
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

  /*
   * Coming back from a Cloudflare sign-in.
   *
   * The session is already set by the time the browser gets here, so a success
   * needs nothing but tidying the address. A refusal does need saying: the
   * reader pressed a button, went to Cloudflare, came back, and would
   * otherwise be looking at the same sign-in screen with no idea why.
   *
   * Only the sign-in outcomes are taken here. Connecting storage answers on
   * the Data page, which is where that was started from.
   */
  const [signInError, setSignInError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('cloudflare');
    if (outcome !== 'signed_in' && outcome !== 'error') return;
    const code = params.get('cloudflare_error') ?? '';
    if (outcome === 'error' && !authErrorKey(code)) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    if (outcome === 'error') setSignInError(t(authErrorKey(code) as MessageKey));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/v1/setup/status').then(async (response) => response.json() as Promise<SetupStatus>).then(async (status) => {
      if (cancelled) return;
      setCloudflareSignIn(status.cloudflareSignIn ?? null);
      if (status.setupRequired) { setMode('setup'); return; }
      // The session probe and the sign-in form are the calls where a refusal
      // is an ordinary answer rather than a session running out, so they go
      // straight to `fetch`. Routed through the watch, a first visit would be
      // met by a notice saying the reader had been signed out of something,
      // and a mistyped password would say the same.
      const held = sessionToken();
      const response = await fetch('/api/v1/auth/session', { credentials: 'same-origin', ...(held ? { headers: { authorization: `Bearer ${held}` } } : {}) });
      if (!response.ok) { setSessionToken(null); if (!cancelled) setMode('login'); return; }
      const payload = await response.json() as { session: { csrfToken: string }; token?: string };
      // Held for the calls after this one, which may be the only thing keeping
      // a console inside another site's page signed in; see session.ts.
      if (payload.token) setSessionToken(payload.token);
      if (!cancelled) { setCsrfToken(payload.session.csrfToken); setMode('ready'); }
    }).catch(() => { if (!cancelled) setMode('login'); });
    return () => { cancelled = true; };
  }, []);

  /**
   * Leave, deliberately.
   *
   * Without this the only way out was to wait for the session to expire, and
   * the notice that follows an expiry - "you were signed out, sign in again" -
   * is the wrong thing to say to somebody who just pressed Sign out.
   */
  const signOut = async () => {
    await apiFetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin', headers: csrfToken ? { 'x-csrf-token': csrfToken } : {} }).catch(() => undefined);
    setSessionToken(null);
    resetSessionWatch();
    setSignedOut(false);
    setCsrfToken(null);
    setMode('login');
  };

  const signedIn = (token: string, setUp = false) => {
    // Arm the watch again: the session that expired is not the session now held.
    resetSessionWatch();
    setSignedOut(false);
    setCsrfToken(token);
    setFirstRun(setUp);
    setMode('ready');
  };

  // Until the session check answers there is nothing to ask for. Falling
  // through to the form showed a flash of the login screen on every reload of
  // an already signed-in console.
  const waiting = <div className="auth-shell" role="status" aria-busy="true" />;
  const body = mode === 'checking'
    ? waiting
    : mode === 'ready'
      ? csrfToken
        ? firstRun
          ? <FirstRun t={t} csrfToken={csrfToken} preferences={preferences} onPreferencesChange={changePreferences} onDone={() => setFirstRun(false)} />
          : <ConsoleApp csrfToken={csrfToken} preferences={preferences} onPreferencesChange={changePreferences} onSignOut={signOut} />
        : waiting
      : <AuthScreen
        t={t}
        mode={mode}
        signedOut={signedOut}
        preferences={preferences}
        cloudflare={cloudflareSignIn}
        refusal={signInError}
        onPreferencesChange={changePreferences}
        onSignedIn={signedIn}
      />;

  /*
   * Results are reported from here down, so the provider is here.
   *
   * It used to be inside the console, which meant the console's own handlers -
   * start, stop, remove SillyTavern - got the no-op fallback instead of the
   * real one and reported nothing at all. This is also where the language
   * lives, so the close button is labelled in the reader's language and
   * follows them when they change it.
   */
  return <Toaster closeLabel={t('common.close')}>{body}</Toaster>;
}

function AuthScreen({ t, mode, signedOut, preferences, cloudflare, refusal, onPreferencesChange, onSignedIn }: { t: Translate; mode: 'setup' | 'login'; signedOut: boolean; preferences: Preferences; onPreferencesChange: (value: Partial<Preferences>) => void; cloudflare: SetupStatus['cloudflareSignIn'] | null; refusal: string | null; onSignedIn: (csrfToken: string, setUp: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [cloudflareBusy, setCloudflareBusy] = useState(false);
  /** Set when this page could not open Cloudflare's sign-in and handed it over. */
  const [handOverUrl, setHandOverUrl] = useState<string | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legalOpen, setLegalOpen] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocumentId>('terms');
  /*
   * How many times a button has been pressed with the box still unticked.
   *
   * Counted rather than flagged so the sentence can be pointed at again on the
   * second press: the animation is restarted by remounting on this key, and a
   * boolean that is already true remounts nothing.
   */
  const [nudges, setNudges] = useState(0);
  const termsId = useId();
  const setup = mode === 'setup';
  /*
   * Whether to offer the platform's own address first; see
   * PlatformAddressOffer. Decided once, as the screen opens.
   */
  const [addressOffer, setAddressOffer] = useState(() => setup && shouldOfferPlatformAddress({ hostname: window.location.hostname, framed: framed(), answered: readAddressOfferAnswered(browserStorage()) }));
  /*
   * Set up, and waiting on the console's own link rather than going in.
   *
   * Holds the session the setup opened, which is what turns the link on. The
   * reader leaves for the link from here; nothing is installed until they sign
   * in there - see `firstRunDeferred` on the server.
   */
  const [linkStage, setLinkStage] = useState<string | null>(null);
  const answerAddressOffer = (ownLink: boolean) => {
    saveAddressOfferAnswered(browserStorage());
    if (ownLink) saveOwnLinkWanted(browserStorage(), true);
    setAddressOffer(false);
  };
  const fail = failures(preferences.locale);
  // Shown once the second field stops being a prefix of the first, rather than
  // the moment the two differ - a mismatch warning under a half-typed password
  // is noise that goes away on its own.
  const mismatch = setup && confirmPassword.length > 0 && !password.startsWith(confirmPassword);
  /*
   * The two passwords, which is all that decides whether the buttons are live.
   *
   * The box is deliberately not part of this. A greyed-out button says "not
   * yet" and nothing else - so somebody who had typed a password twice and was
   * looking at a dead Cloudflare button had no way of learning that the reason
   * was a checkbox further down the card, and the obvious reading is that the
   * sign-in is broken. Pressing now points at the sentence instead, which
   * answers the question being asked.
   */
  const ready = password.length >= MIN_MANAGER_PASSWORD
    && (!setup || password === confirmPassword);
  /**
   * Whether this press may go through, and if not, why not - visibly.
   *
   * Returns false and shakes the consent sentence rather than doing nothing,
   * because doing nothing is indistinguishable from being broken.
   */
  const consented = (): boolean => {
    if (!setup || accepted) return true;
    setNudges((count) => count + 1);
    return false;
  };

  const submit = async () => {
    if (!consented()) return;
    setBusy(true); setError(null);
    // Asked for a link of its own before the password: the first run waits
    // for the sign-in at that link.
    const ownLink = setup && readOwnLinkWanted(browserStorage());
    try {
      // Not `apiFetch`: see the note on the session probe above.
      const response = await fetch(setup ? '/api/v1/setup/password' : '/api/v1/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(setup ? { password, termsAccepted: accepted, telemetryAccepted: accepted, ...(ownLink ? { deferFirstRun: true } : {}) } : { password }),
      });
      const payload = await response.json() as { session?: { csrfToken: string }; token?: string; firstRun?: boolean; error?: { code?: string; message?: string } };
      if (!response.ok || !payload.session) {
        const key = authErrorKey(payload.error?.code);
        setError(key ? t(key) : fail.body(payload, t('setup.authError')));
        return;
      }
      if (payload.token) setSessionToken(payload.token);
      if (ownLink) { saveOwnLinkWanted(browserStorage(), false); setLinkStage(payload.session.csrfToken); return; }
      // A sign-in that takes a first run put off at setup is, to this screen,
      // the end of a setup: the first-run card follows it.
      onSignedIn(payload.session.csrfToken, setup || payload.firstRun === true);
    } catch { setError(t('setup.connectionError')); } finally { setBusy(false); }
  };

  /**
   * Open the console with a Cloudflare account instead of a password.
   *
   * Nothing is typed and nothing comes back here: Cloudflare sends the browser
   * to the callback, which starts the session and reloads onto the console. On
   * a machine that has just been wiped it also brings the settings, the
   * passcode and the chats back on its own - which is the reason this exists.
   */
  /*
   * What the reader is waiting on while the window is open.
   *
   * Kept so it stops when this screen goes away, and so a second press does
   * not leave the first one still asking.
   */
  const collecting = useRef<(() => void) | null>(null);
  useEffect(() => () => collecting.current?.(), []);

  const collected = (result: CollectedResult) => {
    setCloudflareBusy(false);
    if (result.outcome === 'error') {
      const key = authErrorKey(result.code);
      setError(key ? t(key) : t('setup.cloudSignInFailed'));
      return;
    }
    // A sign-in that ended anywhere but signed in - an account still to be
    // chosen, say - is not this screen's to finish, and saying nothing would
    // leave the reader watching a spinner that has stopped meaning anything.
    if (!result.session) { setError(t('setup.cloudSignInFailed')); return; }
    setSessionToken(result.session.token);
    onSignedIn(result.session.csrfToken, setup);
  };

  const signInWithCloudflare = async () => {
    setHandOverUrl(null);
    collecting.current?.();
    /*
     * Cloudflare's sign-in will not load in a frame, so a console inside
     * another site's page sends the reader to a window of its own - opened
     * now, while the click is still a click, or the browser takes it for a
     * pop-up. That window cannot answer back, so the answer is collected from
     * the manager instead; see oauth.ts.
     *
     * A browser that has already refused this console a window is not asked
     * again. The refusal is a property of the frame rather than of the press,
     * so trying costs a second pop-up warning and buys nothing - and the thing
     * that does work is a press on an ordinary link, which is what the button
     * turns into below.
     */
    const inFrame = framed();
    const opened = inFrame && !popupsBlocked() ? openReturnWindow() : null;
    setCloudflareBusy(true); setError(null);
    try {
      // Inside a frame the answer is always collected from the manager,
      // whether the window was opened here or by the reader: either way it
      // cannot carry the answer home by itself.
      const response = await fetch(`/api/v1/auth/cloudflare${inFrame ? '?handoff=1' : ''}`, { method: 'POST', credentials: 'same-origin' });
      const payload = await response.json() as { url?: string; handoff?: string; error?: { code?: string; message?: string } };
      if (!response.ok || !payload.url) { opened?.close(); setCloudflareBusy(false); setError(fail.body(payload, t('setup.cloudSignInFailed'))); return; }
      if (!inFrame) { window.location.assign(payload.url); return; }
      if (payload.handoff) {
        const stopCollecting = collectCloudflareResult(payload.handoff, collected);
        const stopWatching = opened ? whenAbandoned(opened, () => { stopCollecting(); setCloudflareBusy(false); }) : null;
        collecting.current = () => { stopCollecting(); stopWatching?.(); };
      }
      if (opened) { opened.location.href = payload.url; return; }
      /*
       * No window, so the reader opens it: the same button, one more press,
       * now an ordinary link that no browser blocks.
       *
       * This used to be a banner carrying the whole address, a Copy button and
       * an Open button - which was a lot of screen for something that ends in
       * one press on a link, and the link it offered was the very thing the
       * reader had already pressed a button for. The sign-in is already
       * started and already being collected; all that is missing is the press.
       */
      setCloudflareBusy(false);
      setHandOverUrl(payload.url);
    } catch { opened?.close(); setCloudflareBusy(false); setError(t('setup.connectionError')); }
  };
  /*
   * The second way in, where this build has one.
   *
   * On a first run it sits above the terms rather than below the password,
   * because it is the way in this project recommends: on a machine that is
   * wiped between runs a password set here is gone with everything else by
   * tomorrow, and the account that comes back with the chats and the settings
   * is not. It wears Cloudflare's own orange, the same as the button on the
   * Data page, because it hands the reader over to Cloudflare and they decide
   * whether to trust it by recognising it.
   *
   * Nothing is written underneath it. A paragraph explaining what a sign-in is
   * for is read by nobody standing in front of two buttons; the tag on the
   * corner says the one thing that changes which one they press.
   */
  const cloudflareWay = cloudflare?.available ? <>
    <div className="auth-divider"><span>{t('setup.or')}</span></div>
    {/* One line, because there is one thing left to do and the button under it
        is the thing. */}
    {handOverUrl ? <Alert><CloudflareMark /><AlertDescription>{t('console.cfConnectPopupBlocked')}</AlertDescription></Alert> : null}
    <div className="cloud-way">
      {handOverUrl
        ? <Button
          asChild
          size="lg"
          className="w-full hover:opacity-90"
          style={{ backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' }}
        >
          <a href={handOverUrl} target="_blank" rel="noopener noreferrer"><CloudflareMark />{t('setup.cloudSignIn')}</a>
        </Button>
        : <Button
          type="button"
          size="lg"
          className="w-full hover:opacity-90"
          style={{ backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' }}
          disabled={busy}
          loading={cloudflareBusy}
          // Live whether or not the box is ticked. Signing in this way is what
          // sets the manager up, so the agreement is still required first - it
          // is asked for by pointing at it, not by refusing to respond.
          onClick={() => { if (consented()) void signInWithCloudflare(); }}
        >
          <CloudflareMark />{t('setup.cloudSignIn')}
        </Button>}
      <span className="cloud-way-tag" aria-hidden="true">{t('setup.cloudRecommended')}</span>
    </div>
  </> : null;

  return (
    <AuthLayout
      title={linkStage ? t('setup.ownLinkTitle') : setup ? t('setup.title') : t('setup.loginTitle')}
      // Nothing under the title while the address is offered: the card is the
      // one thing to read.
      subtitle={linkStage ? t('setup.ownLinkBody') : addressOffer ? null : setup ? t('setup.subtitle') : t('setup.loginSubtitle')}
      // The credit is on both screens. On the first run it answers "what is
      // this and who wrote it?" before anything is typed into it; afterwards
      // it is the fastest way to read off the version a fault report needs.
      footer={<>
        {setup ? <p>{t('setup.telemetryNotice')}</p> : null}
        <LegalCredit t={t} />
      </>}
      controls={<>
        <LanguageControl t={t} preferences={preferences} onChange={onPreferencesChange} />
        <Button variant="ghost" size="icon-sm" className="size-9" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => onPreferencesChange({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
          {preferences.theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </>}
    >
      {linkStage ? <OwnLinkStage t={t} csrfToken={linkStage} fail={fail} /> : addressOffer ? <PlatformAddressOffer t={t} address={`${window.location.origin}/`} onOpen={() => answerAddressOffer(false)} onOwnLink={() => answerAddressOffer(true)} onSkip={() => answerAddressOffer(false)} /> : <Card className="rounded-2xl">
        <CardContent className="p-6">
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
            {setup ? cloudflareWay : null}
            {setup ? (
              <TermsConsent
                t={t}
                locale={preferences.locale}
                nudges={nudges}
                id={termsId}
                checked={accepted}
                onCheckedChange={setAccepted}
                onOpenDocument={(document) => { setLegalDocument(document); setLegalOpen(true); }}
              />
            ) : null}
            {/* A refusal from this form, or one that came back through the
                Cloudflare redirect - which the reader has no other way of
                being told about. */}
            {error ?? refusal ? <Alert variant="destructive"><AlertDescription>{error ?? refusal}</AlertDescription></Alert> : null}
            <Button type="submit" size="lg" className="w-full" disabled={cloudflareBusy || !ready} loading={busy}>
              {setup ? t('setup.createAdmin') : t('setup.signIn')}
            </Button>
            {!setup ? cloudflareWay : null}
          </form>
        </CardContent>
      </Card>}
      <LegalDialog
        t={t}
        locale={preferences.locale}
        open={legalOpen}
        onOpenChange={setLegalOpen}
        document={legalDocument}
        onDocumentChange={setLegalDocument}
      />
    </AuthLayout>
  );
}

/**
 * Before the password: open this console at the address it is already at.
 *
 * A studio shows a new app inside its own page, and the address in that frame
 * - one the platform gave out - already reaches this console. Opened in a tab
 * of its own it is the console without the studio around it, with nothing to
 * set up and nothing to keep running, which is why it is the button the eye
 * lands on. A link of the console's own is the second choice: one fixed
 * address through Cloudflare, opened once there is a password to guard it.
 *
 * The address opens through an ordinary link, which no browser treats as a
 * pop-up. Whatever is chosen, this screen carries on to the password, so the
 * frame left behind is still a working console.
 */
function PlatformAddressOffer({ t, address, onOpen, onOwnLink, onSkip }: { t: Translate; address: string; onOpen: () => void; onOwnLink: () => void; onSkip: () => void }) {
  return <Card className="rounded-2xl">
    <CardContent className="grid gap-4 p-6">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">{t('setup.addressFound')}</h2>
        <p className="text-sm text-muted-foreground">{t('setup.addressHint')}</p>
      </div>
      <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5">
        <Globe2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{bareHost(address)}</span>
      </div>
      <Button asChild size="lg" className="w-full">
        <a href={address} target="_blank" rel="noopener noreferrer" onClick={onOpen}><ArrowUpRight />{t('setup.addressOpen')}</a>
      </Button>
      {/* Quieter than the button above on purpose: no border, no brand. */}
      <div className="grid gap-1">
        <Button type="button" variant="ghost" className="w-full text-muted-foreground" onClick={onOwnLink}><Globe2 />{t('setup.addressOwnLink')}</Button>
        <Button type="button" variant="ghost" className="w-full text-muted-foreground" onClick={onSkip}>{t('setup.addressSkip')}</Button>
      </div>
    </CardContent>
  </Card>;
}

/**
 * After the password, for a reader who asked for a link of the console's own:
 * the link, and nothing else.
 *
 * The console is not opened here. The reader is about to leave for the link,
 * and everything a first run starts - SillyTavern's installation, the offer
 * to connect a Cloudflare account - belongs where they are going, so it waits
 * for them to sign in there. This screen turns the link on, says so while
 * cloudflared comes up, and hands the address over.
 */
function OwnLinkStage({ t, csrfToken, fail }: { t: Translate; csrfToken: string; fail: Fail }) {
  const [tunnel, setTunnel] = useState<TunnelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    // Until the address is announced, or something says it will not be.
    const watch = async (): Promise<void> => {
      try {
        const response = await apiFetch('/api/v1/manager-tunnel', { credentials: 'same-origin' });
        if (response.ok) {
          const state = await response.json() as TunnelState;
          if (cancelled) return;
          setTunnel(state);
          if (publicAddress(state)) return;
          if (state.status === 'error') { setError(state.error ?? t('setup.ownLinkFailed')); return; }
        }
      } catch {
        // Asked again below; a moment without an answer is not a failure.
      }
      if (!cancelled) timer = window.setTimeout(() => void watch(), 1500);
    };
    setError(null);
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/manager-tunnel', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: 'quick' }) });
        const payload: unknown = await response.json();
        if (cancelled) return;
        if (!response.ok) { setError(fail.body(payload, t('setup.ownLinkFailed'))); return; }
        setTunnel(payload as TunnelState);
        void watch();
      } catch { if (!cancelled) setError(t('setup.ownLinkFailed')); }
    })();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [attempt]);
  const address = tunnel ? publicAddress(tunnel) : null;
  // The page's own title and subtitle say what this is; the card holds the link.
  return <Card className="rounded-2xl">
    <CardContent className="grid gap-5 p-6">
      {error
        ? <>
          <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
          <Button type="button" variant="outline" className="w-full" onClick={() => setAttempt((count) => count + 1)}><RefreshCw />{t('setup.ownLinkRetry')}</Button>
        </>
        : address
          ? <>
            <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5">
              <span className="mt-0.5 shrink-0" style={{ color: CLOUDFLARE_ORANGE }} aria-hidden="true"><CloudflareMark size={14} /></span>
              <span className="min-w-0 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{bareHost(address)}</span>
            </div>
            <Button asChild size="lg" className="w-full">
              <a href={address} target="_blank" rel="noopener noreferrer"><ArrowUpRight />{t('setup.ownLinkGo')}</a>
            </Button>
            <p className="text-xs text-muted-foreground">{t('setup.ownLinkNext')}</p>
          </>
          : <div className="grid gap-2" role="status">
            <span className="thinking text-sm">{t('setup.ownLinkOpening')}</span>
            <TaskBar />
          </div>}
    </CardContent>
  </Card>;
}

/** The documents the consent sentence names, in the order it names them. */
const CONSENT_DOCUMENTS = ['terms', 'disclaimer'] as const;
type ConsentDocument = typeof CONSENT_DOCUMENTS[number];

/**
 * The consent sentence, with the documents in it as the way into them.
 *
 * It used to be one button carrying the whole sentence and a "Read the full
 * text" underneath it, which made the two things somebody does here fight each
 * other: reading opened a dialog and agreeing needed the small box, and the
 * words that name the documents - the words a reader actually reaches for -
 * did nothing at all.
 *
 * So the sentence is split at the document names. Those are links, in the
 * accent colour every other link on the console uses, and each opens its own
 * document. Everything else is a label for the box, so clicking the text
 * agrees, which is what clicking a consent sentence is expected to do.
 *
 * The names come from the legal bundle rather than from the sentence, so they
 * read exactly as the dialog titles the reader lands on, in either language.
 */
function TermsConsent({ t, locale, id, nudges, checked, sentence = 'setup.terms', onCheckedChange, onOpenDocument }: {
  t: Translate;
  locale: LocaleCode;
  id: string;
  /** Presses made with the box unticked; each one shakes the sentence once. */
  nudges: number;
  checked: boolean;
  /**
   * Which sentence is being agreed to. Setting up is one occasion; a revision
   * met by somebody already using the manager is the other, and it is a
   * different sentence because they are not being asked the same thing.
   */
  sentence?: MessageKey;
  onCheckedChange: (checked: boolean) => void;
  onOpenDocument: (document: LegalDocumentId) => void;
}) {
  const bundle = legalBundle(locale);
  const titleOf = (document: ConsentDocument): string =>
    bundle.documents.find((entry) => entry.id === document)?.title ?? document;
  const template = t(sentence);
  // The same sentence with the names filled in, for anybody who meets the box
  // through a screen reader rather than through the text beside it.
  const plain = t(sentence, Object.fromEntries(CONSENT_DOCUMENTS.map((document) => [document, titleOf(document)])));
  /*
   * Keyed on the count so the animation runs again on every press.
   *
   * A CSS animation plays once per element, and the element is otherwise the
   * same element - so the second press would light nothing up and read as the
   * button having gone dead after all. Remounting is cheap here and there is
   * no state inside to lose: the box is controlled from above.
   */
  return <div className={nudges > 0 ? 'terms-consent terms-nudge' : 'terms-consent'} key={nudges}>
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      aria-label={plain}
      className="mt-0.5"
    />
    <label className="terms-text" htmlFor={id}>
      {splitOnPlaceholders(template).map((piece, index) => (piece.placeholder === null
        ? <span key={index}>{piece.text}</span>
        : <button
          key={index}
          type="button"
          className="terms-link"
          aria-haspopup="dialog"
          title={t('setup.termsOpen', { name: titleOf(piece.placeholder as ConsentDocument) })}
          // The label would otherwise pass the click on to the box, so
          // opening a document would also agree to it.
          onClick={(event) => { event.preventDefault(); onOpenDocument(piece.placeholder as LegalDocumentId); }}
        >{titleOf(piece.placeholder as ConsentDocument)}<ArrowUpRight /></button>))}
    </label>
  </div>;
}

/**
 * A sentence cut into its literal parts and its `{name}` slots, in order.
 *
 * `interpolate` turns a slot into a string, and a link is not a string - so
 * the sentence is split here instead and each slot handed to the caller to
 * render however it likes. A slot this caller does not know is left as the
 * literal text it was written as, which is what every other unfilled
 * placeholder in the panel does.
 */
function splitOnPlaceholders(template: string): Array<{ text: string; placeholder: string | null }> {
  const pieces: Array<{ text: string; placeholder: string | null }> = [];
  let at = 0;
  for (const match of template.matchAll(/\{([^{}]+)\}/gu)) {
    const start = match.index;
    const name = match[1] ?? '';
    if (start > at) pieces.push({ text: template.slice(at, start), placeholder: null });
    pieces.push(CONSENT_DOCUMENTS.includes(name as ConsentDocument)
      ? { text: '', placeholder: name }
      : { text: match[0], placeholder: null });
    at = start + match[0].length;
  }
  if (at < template.length) pieces.push({ text: template.slice(at), placeholder: null });
  return pieces;
}

/**
 * The one step between setting a password and the console, on a first run.
 *
 * Backing up to a Cloudflare account has always been on the settings page,
 * which is where somebody goes once they have a problem - by which time the
 * chats worth keeping are on a machine with no copy of them anywhere else.
 * Offered here it costs one decision, at the only moment when there is nothing
 * to lose by saying yes and nothing to undo by saying no.
 *
 * It is also how a machine set up on an account that already has one hands
 * everything back: signing in brings the recovery points and the settings the
 * other machine left, which is what the Data page says as soon as this ends.
 *
 * Skipped without being shown where signing in to Cloudflare is not available
 * at all - no OAuth client configured, or a build set up for S3 keys only -
 * because an offer that cannot be accepted is a step that wastes a click.
 */
function FirstRun({ t, csrfToken, preferences, onPreferencesChange, onDone }: { t: Translate; csrfToken: string; preferences: Preferences; onPreferencesChange: (value: Partial<Preferences>) => void; onDone: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = failures(preferences.locale);

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/v1/r2', { credentials: 'same-origin' })
      .then(async (response) => (response.ok ? (await response.json() as { config: R2Config }).config : null))
      .then((config) => {
        if (cancelled) return;
        // Already connected - a manager whose settings came from `.env`, say.
        // There is nothing to offer and nothing to ask.
        if (!config?.cloudflare || config.configured) { onDone(); return; }
        setAvailable(true);
      })
      .catch(() => { if (!cancelled) onDone(); });
    return () => { cancelled = true; };
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/connect', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { url?: string; error?: { message?: string } };
      if (!response.ok || !payload.url) { setError(fail.body(payload, t('console.cfConnectFailed'))); return; }
      // Cloudflare answers back to the console's own address, which lands on
      // the Data page with the connection made; see handleCloudflareCallback.
      window.location.assign(payload.url);
    } catch { setError(t('console.cfConnectFailed')); } finally { setBusy(false); }
  };

  if (available !== true) return <div className="auth-shell" role="status" aria-busy="true" />;
  return (
    <AuthLayout
      title={t('setup.cloudTitle')}
      subtitle={t('setup.cloudSubtitle')}
      controls={<>
        <LanguageControl t={t} preferences={preferences} onChange={onPreferencesChange} />
        <Button variant="ghost" size="icon-sm" className="size-9" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => onPreferencesChange({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
          {preferences.theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </>}
      footer={<LegalCredit t={t} />}
    >
      <Card className="rounded-2xl">
        <CardContent className="grid gap-5 p-6">
          {/* Said in a picture first: what is here keeps a copy over there,
              and the stream between them does not stop while the machine is
              in use. Hidden from a reader who is being read to, because the
              sentence below it says the same thing in words. */}
          <div className="cloud-offer-figure" aria-hidden="true">
            <div className="cloud-offer-node">
              <span className="cloud-offer-tile"><Monitor /></span>
              <span className="cloud-offer-label">{t('setup.cloudHere')}</span>
            </div>
            <span className="cloud-offer-stream" />
            <div className="cloud-offer-node cloud-offer-node-away">
              <span className="cloud-offer-tile"><Cloud /></span>
              <span className="cloud-offer-label">{t('setup.cloudAway')}</span>
            </div>
          </div>
          {/* The claim first and the mechanism under it, rather than one grey
              block holding both. What somebody decides on is the first line;
              the second is there for whoever wants to know how. */}
          <div className="grid gap-1.5">
            <p className="text-[15px] leading-snug font-medium text-foreground">{t('setup.cloudClaim')}</p>
            <p className="text-sm text-muted-foreground">{t('setup.cloudBody')}</p>
          </div>
          <ul className="grid gap-2.5">
            <li className="cloud-offer-point"><Leaf /><span>{t('setup.cloudPointFree')}</span></li>
            <li className="cloud-offer-point"><History /><span>{t('setup.cloudPointRestore')}</span></li>
          </ul>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <div className="grid gap-2">
            <Button size="lg" className="w-full hover:opacity-90" style={{ backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' }} loading={busy} onClick={() => connect()}>
              <CloudflareMark />{t('setup.cloudConnect')}
            </Button>
            <Button variant="ghost" size="lg" className="w-full" disabled={busy} onClick={onDone}>{t('setup.cloudSkip')}</Button>
          </div>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

function ConsoleApp({ csrfToken, preferences, onPreferencesChange, onSignOut }: { csrfToken: string; preferences: Preferences; onPreferencesChange: (value: Partial<Preferences>) => void; onSignOut: () => Promise<void> }) {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [version, setVersion] = useState('latest');
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  // Whether the list above is the manager's answer yet, rather than the
  // empty one this page starts with.
  const [installationsLoaded, setInstallationsLoaded] = useState(false);
  const [activeInstallationId, setActiveInstallationId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [installing, setInstalling] = useState(false);
  const [pendingInstallationId, setPendingInstallationId] = useState<string | null>(null);
  /** The job behind the install in flight, which is what stopping it asks for. */
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  /**
   * A backup, an upload or a recovery the manager is running on its own.
   *
   * Held here rather than on the Data page, because the page somebody is
   * looking at when a machine puts itself back together is the Overview.
   */
  const [backgroundJob, setBackgroundJob] = useState<Job | null>(null);
  /** The job the last poll saw, so the moment one finishes can be noticed. */
  const backgroundJobSeen = useRef<string | null>(null);
  /** What the manager does with SillyTavern on its own way up. Null until read. */
  const [startup, setStartup] = useState<StartupSettings | null>(null);
  const [saver, setSaver] = useState<SaverState | null>(null);
  /** Whether the manager keeps itself online, and how that is going. */
  const [online, setOnline] = useState<OnlineState | null>(null);
  const [logSource, setLogSource] = useState<LogSourceFilter>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [compactLogs, setCompactLogs] = useState(false);
  /*
   * The log buffer and the machine's meters, both filled by the one poll below.
   *
   * Declared here, above that poll, because it is what fills them - and a
   * reader following this file should meet the thing being filled before the
   * filling. Neither of them asks the manager anything on its own any more.
   */
  const liveLogs = useLiveLogs(logSource);
  const { snapshot: systemSnapshot, accept: acceptSystem, remeasure } = useSystemSnapshot(csrfToken);
  /** The archive list this console already holds, so an unchanged one is not resent. */
  const backupsTag = useRef<string | null>(null);
  /** Whether the manager has asked for a slower clock; see `polling.ts`. */
  const [easePolling, setEasePolling] = useState(false);
  const [processState, setProcessState] = useState<ProcessState>({ status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null });
  const [tunnelState, setTunnelState] = useState<TunnelState>({ mode: 'off', status: 'stopped', url: null, startedAt: null, error: null });
  const [managerTunnelState, setManagerTunnelState] = useState<TunnelState>({ mode: 'off', status: 'stopped', url: null, startedAt: null, error: null });
  const [configDocument, setConfigDocument] = useState<ConfigDocument | null>(null);
  const [portSettings, setPortSettings] = useState<PortSettings | null>(null);
  /*
   * What this account remembers about a machine, and whether it is this one.
   *
   * Kept here rather than on the Data page, because the offer to put a machine
   * back together is not a fact about backups - it is the first thing somebody
   * who has just signed in on an empty machine needs, whichever page they land
   * on, and they land on the Overview. It sat on the Data page, below the
   * backup table, behind a tab nobody had a reason to open yet.
   */
  const [settingsOffer, setSettingsOffer] = useState<ManagerSettingsOffer | null>(null);
  const [dismissedSettings, setDismissedSettings] = useState<string | null>(() => readDismissedSettings(browserStorage()));
  const [restoringEverything, setRestoringEverything] = useState(false);
  /*
   * Which machine the account says is backing up, when it is not this one.
   *
   * Kept beside the offer above and asked for in the same breath, because the
   * two are the same moment from opposite sides: one console has just taken
   * the account and is being offered the other machine's setup, and the other
   * console has just lost it and has been told nothing.
   */
  const [r2Owner, setR2Owner] = useState<R2Config['owner'] | null>(null);
  /*
   * The account is signed in and has never turned R2 on, so there is nowhere
   * for a backup to go and nothing this manager can do about it.
   *
   * It used to be said only inside the form where the account was chosen,
   * which is a form somebody closes and does not open again - so a machine
   * that was backing nothing up looked exactly like one that was.
   */
  const [r2Problem, setR2Problem] = useState<CloudflareAccountProblem | null>(null);
  const [reconnectUrl, setReconnectUrl] = useState<string | null>(null);
  /*
   * A newer manager than this one, when the project has published one.
   *
   * The console has always said when SillyTavern had a new release, because
   * installing SillyTavern is what it does; it said nothing about itself, so
   * somebody could run a version from six months ago and never find out. The
   * manager answers this from what it last read, so the question is cheap and
   * the answer is a release rather than a version number: what was changed is
   * the part anybody decides on.
   */
  const [managerUpdate, setManagerUpdate] = useState<ManagerUpdateStatus | null>(null);
  const [dismissedManagerRelease, setDismissedManagerRelease] = useState<string | null>(() => readDismissedManagerRelease(browserStorage()));
  /*
   * Whether the terms in force are the ones this installation agreed to.
   *
   * Read once, as the page loads, and that is not a shortcut: the documents
   * are compiled into the program on both sides, so the answer can only change
   * when the manager is replaced - and a replaced manager means a reloaded
   * page. Polling it would be asking the same question of the same two
   * constants every few seconds.
   */
  const [legalReview, setLegalReview] = useState<LegalReview | null>(null);
  const [legalAgreed, setLegalAgreed] = useState(false);
  const [legalNudges, setLegalNudges] = useState(0);
  const [legalBusy, setLegalBusy] = useState(false);
  const [legalFailure, setLegalFailure] = useState<string | null>(null);
  const [reviewLegalOpen, setReviewLegalOpen] = useState(false);
  const [reviewLegalDocument, setReviewLegalDocument] = useState<LegalDocumentId>('terms');
  const [securityLoaded, setSecurityLoaded] = useState(false);
  const [accessSecurity, setAccessSecurity] = useState<AccessGatewayState>({ status: 'stopped', host: null, port: 8001, lan: false, passwordConfigured: false, passcode: false, sessions: 0, error: null });
  const t = translator(preferences.locale);
  const catalog = logCatalog(preferences.locale);
  const fail = failures(preferences.locale);
  const { toast } = useToast();

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


  // Not tied to an installation: which ports this manager holds is true before
  // anything is installed, and the page that shows them says so either way.
  // Kept current afterwards by the status poll, which a restore moves.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await apiFetch('/api/v1/config/port', { credentials: 'same-origin' });
      if (response.ok && !cancelled) setPortSettings(await response.json() as PortSettings);
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  /*
   * Another manager signed in with this Cloudflare account, so this one is
   * out: it has given its own sign-in up and can reach nothing in that
   * account until somebody signs in here again. Nothing that would need the
   * account is offered while this is true.
   */
  const displaced = Boolean(r2Owner) && r2Owner?.mine === false;
  const [dismissedDisplaced, setDismissedDisplaced] = useState<string | null>(() => readDismissedDisplaced(browserStorage()));
  /*
   * Whether this account holds a machine's setup, and whether it is this one.
   *
   * Asked as the console opens and again once a background operation ends -
   * which is when it changes, because that is when a restore has just made
   * this machine the one the record describes. Not on a clock: reading it is a
   * charged request to the bucket, and it is one small document.
   */
  const askAboutSettings = async (): Promise<void> => {
    try {
      const response = await apiFetch('/api/v1/r2/settings', { credentials: 'same-origin' });
      if (!response.ok) return;
      const payload = await response.json() as { settings: ManagerSettingsOffer; owner?: R2Config['owner'] | null };
      setSettingsOffer(payload.settings);
      setR2Owner(payload.owner ?? null);
    } catch {
      // Nothing is offered, which is the same as there being nothing to offer.
    }
  };
  useEffect(() => { void askAboutSettings(); }, []);

  /**
   * Take the account back, from the console that lost it.
   *
   * The same sign-in the other machine used, so this is symmetrical: whoever
   * signs in last is the one that backs up. The window is opened while the
   * click is still a click, unless this browser has already refused one - in
   * which case the button below becomes a plain link; see oauth.ts.
   */
  const signInToCloudflareAgain = async (): Promise<void> => {
    const inFrame = framed();
    const opened = inFrame && !popupsBlocked() ? openReturnWindow() : null;
    try {
      const response = await apiFetch(`/api/v1/r2/cloudflare/connect${inFrame ? '?handoff=1' : ''}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { url?: string };
      if (!response.ok || !payload.url) { opened?.close(); return; }
      if (!inFrame) { window.location.assign(payload.url); return; }
      if (opened) { opened.location.href = payload.url; return; }
      setReconnectUrl(payload.url);
    } catch {
      opened?.close();
      // The card stays, and pressing again tries again.
    }
  };
  /** The overview's half of the R2 check; see `R2ActivationActions`. */
  const recheckR2 = async (quiet = false) => {
    const outcome = await recheckR2Activation(csrfToken);
    if (outcome.state === 'enabled') {
      setR2Problem(null);
      toast({ title: t('console.cfConnected', { bucket: outcome.config.cloudflare?.bucket ?? '' }), tone: 'success' });
    } else if (!quiet) {
      toast({ title: outcome.state === 'still_off' ? t('console.cfR2StillOff') : fail.body(outcome.payload, t('console.cfConnectFailed')), tone: 'destructive' });
    }
  };

  /**
   * Say that the revised terms have been read, for this installation.
   *
   * The revision goes up with the answer and the manager checks it against the
   * one it carries. A console that has been open since before an update is
   * showing a card about wording this program no longer has, and recording an
   * acknowledgement of a revision nobody was shown would be worse than asking
   * again: the refusal that comes back says to reload and read the new one.
   */
  const acknowledgeLegal = async (): Promise<void> => {
    if (!legalReview) return;
    // Pressing with the box unticked shakes the sentence rather than doing
    // nothing, because doing nothing reads as the button being broken.
    if (!legalAgreed) { setLegalNudges((count) => count + 1); return; }
    setLegalBusy(true);
    setLegalFailure(null);
    try {
      const response = await apiFetch('/api/v1/legal/acknowledge', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ accepted: true, revision: legalReview.effective }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) { setLegalFailure(fail.body(payload, t('console.legalReviewFailed'))); return; }
      setLegalReview(payload as LegalReview);
    } catch {
      setLegalFailure(t('console.legalReviewFailed'));
    } finally {
      setLegalBusy(false);
    }
  };

  const restoreEverything = async (): Promise<void> => {
    setRestoringEverything(true);
    try {
      const response = await apiFetch('/api/v1/r2/restore', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { setRestoringEverything(false); return; }
      // The work itself is a background job, which the console already shows
      // with its own bar and its own Stop button. What is left here is to stop
      // offering a card for work that has started.
      const when = settingsOffer?.writtenAt;
      if (when) { saveDismissedSettings(when, browserStorage()); setDismissedSettings(when); }
    } catch {
      setRestoringEverything(false);
    }
  };

  /*
   * The four things the console watches, in one request on one clock.
   *
   * The clock is fast while something is moving and slow while it is not; see
   * `polling.ts` for why that distinction is worth making and what it costs
   * not to. An install is in motion too, and is the one thing here the server
   * does not report in this answer, so it is passed in.
   */
  usePoll(async () => {
    /*
     * What this answer should carry besides the state above.
     *
     * The log and the archive list always, because the header's dot and the
     * newest-archive line are on every page. The machine's meters only on the
     * page that shows them: they are the largest of the three and the only one
     * with a reader who would notice them missing.
     *
     * The cursor and the tag are what make the other two nearly free. The
     * cursor asks for lines after the last one held, so a quiet log answers in
     * seventy-nine bytes; the tag names the archive list already on screen, so
     * an unchanged one answers in twenty.
     */
    const askedSource = logSource;
    const query = new URLSearchParams({
      include: page === 'overview' ? 'system,logs,backups' : 'logs,backups',
      logsAfter: String(liveLogs.cursor()),
      logsSource: logSource,
    });
    if (backupsTag.current !== null) query.set('backupsTag', backupsTag.current);
    const response = await apiFetch(`/api/v1/status?${query.toString()}`, { credentials: 'same-origin' });
    if (!response.ok) return;
    const status = await response.json() as ConsoleStatus;
    if (status.system) acceptSystem(status.system);
    if (status.logs) liveLogs.accept(status.logs, askedSource);
    if (status.backupsTag !== undefined) backupsTag.current = status.backupsTag;
    // Absent means "the list you have is the list there is", which is the
    // common answer and the reason the tag is sent at all.
    if (status.backups) setBackups([...status.backups]);
    // Said by the manager, which is the only side that can see how much of the
    // day's Worker allowance is left.
    setEasePolling(status.easePolling === true);
    setProcessState(status.process);
    setTunnelState(status.tunnel);
    setManagerTunnelState(status.managerTunnel);
    setAccessSecurity(status.security);
    setSecurityLoaded(true);
    // A restore moves SillyTavern's port, and the page that shows it used to
    // ask once as it loaded - so the console said 8002 over a SillyTavern on
    // 8004 until somebody reloaded it.
    setPortSettings(status.ports);
    /*
     * And who holds the Cloudflare account, which is the other thing this
     * console used to ask once and then believe for the rest of the session.
     *
     * A machine that has the account taken from it stops backing up without
     * anything happening on its screen: there is no request to fail, because
     * a manager with nothing to send makes none. So the notice about it only
     * appeared on the next page load - and what was on the page in the
     * meantime was the old backup card, still describing an account this
     * machine had been locked out of.
     */
    setR2Owner(status.r2Owner);
    setR2Problem(status.r2Problem);
    /*
     * Work this machine started for itself, adopted whenever it appears.
     *
     * The page used to ask about this once, as it loaded. A manager opened
     * with a Cloudflare account begins installing SillyTavern and downloading
     * the profile *after* the redirect has landed, so the one question this
     * page asked was always asked a few seconds too early - and the answer
     * was kept for the several minutes that followed. The reader watched an
     * empty Overview with one line in the log while gigabytes came down.
     */
    // A recovery that has just finished has written into the profile, and may
    // have made the first backup this console has ever had.
    if (backgroundJobSeen.current !== null && status.operation === null) {
      reloadProfiles();
      // A restore that has just finished has made this machine the one the
      // record in the bucket describes, so the card that offered it goes.
      setRestoringEverything(false);
      void askAboutSettings();
    }
    backgroundJobSeen.current = status.operation?.id ?? null;
    setBackgroundJob(status.operation);
    if (status.install && installJobId === null) {
      setInstalling(true);
      setPendingInstallationId(status.install.installationId);
      setInstallJobId(status.install.id);
    }
  }, { intervalMs: statusIntervalMs({ process: processState, tunnel: tunnelState, managerTunnel: managerTunnelState, working: installing || backgroundJob !== null, readingLog: logsExpanded, easePolling }) });

  /*
   * Whether the manager itself has been replaced, asked on a clock of its own.
   *
   * Rarely, because the answer changes when somebody cuts a release rather
   * than while anybody is watching, and because the manager keeps what it last
   * heard for hours - so most of these never leave the machine. Once at load
   * as well, which is what tells a console opened today about a release from
   * last week.
   */
  usePoll(async () => {
    try {
      const response = await apiFetch('/api/v1/manager-update', { credentials: 'same-origin' });
      if (!response.ok) return;
      setManagerUpdate(await response.json() as ManagerUpdateStatus);
    } catch {
      // The next one asks again. Nothing on the page depends on this.
    }
  }, { intervalMs: POLL_RELEASE_MS });

  /*
   * How keeping this manager online is going, while the page showing it is up.
   *
   * Only there: the switch and what it reports live on the settings page, and
   * a console sitting on the Overview has no use for the answer. What it does
   * change without anybody pressing anything is the address - a tunnel coming
   * up gives the manager one it did not have a moment ago - so on that page it
   * is worth asking again rather than showing what was true at load.
   */
  usePoll(async () => {
    try {
      const response = await apiFetch('/api/v1/online', { credentials: 'same-origin' });
      if (response.ok) setOnline(await response.json() as OnlineState);
    } catch {
      // The card keeps what it last knew, and the next one asks again.
    }
  }, { intervalMs: POLL_BACKGROUND_MS, enabled: page === 'config' });

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
      apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null; activeJob: Job | null }> : null),
      apiFetch('/api/v1/profiles', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ profiles: Profile[]; activeProfileId: string | null }> : null),
      apiFetch('/api/v1/backups', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ backups: BackupManifest[] }> : null),
      apiFetch('/api/v1/startup', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ startup: StartupSettings }> : null),
      apiFetch('/api/v1/legal', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<LegalReview> : null),
      apiFetch('/api/v1/online', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<OnlineState> : null),
      apiFetch('/api/v1/saver', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ saver: SaverState }> : null).catch(() => null),
    ]).then(([versionPayload, installationPayload, profilePayload, backupPayload, startupPayload, legalPayload, onlinePayload, saverPayload]) => {
      if (cancelled) return;
      if (startupPayload) setStartup(startupPayload.startup);
      if (saverPayload) setSaver(saverPayload.saver);
      if (legalPayload) setLegalReview(legalPayload);
      if (onlinePayload) setOnline(onlinePayload);
      if (versionPayload) setVersions(versionPayload.versions);
      setInstallationsLoaded(true);
      if (installationPayload) {
        setInstallations(installationPayload.installations);
        setActiveInstallationId(installationPayload.activeInstallationId);
        /*
         * An install already running that this page did not start.
         *
         * Two ways that happens: the page was reloaded during one, and a
         * manager that had just been set up installed SillyTavern by itself.
         * Adopting it is what makes the progress on the card belong to
         * something - and gives the reader the button that stops it.
         */
        if (installationPayload.activeJob) {
          setInstalling(true);
          setPendingInstallationId(installationPayload.activeJob.installationId);
          setInstallJobId(installationPayload.activeJob.id);
        }
      }
      if (profilePayload) { setProfiles(profilePayload.profiles); setActiveProfileId(profilePayload.activeProfileId); }
      if (backupPayload) setBackups(backupPayload.backups);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  /**
   * The profiles, read again after something that makes or fills one.
   *
   * They are read once when the page loads, which is right for a console
   * somebody opens and then uses. It is wrong for the minutes after a
   * Cloudflare sign-in: the first install creates the profile and the recovery
   * fills it, both of them afterwards and neither of them asked for here. The
   * card went on saying "No profiles yet" over a machine that had just brought
   * back two hundred files.
   */
  const reloadProfiles = (): void => {
    void apiFetch('/api/v1/profiles', { credentials: 'same-origin' })
      .then(async (response) => response.ok ? await response.json() as { profiles: Profile[]; activeProfileId: string | null } : null)
      .then((payload) => {
        if (!payload) return;
        setProfiles(payload.profiles);
        setActiveProfileId(payload.activeProfileId);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!installing) return undefined;
    if (!pendingInstallationId) return undefined;
    const timer = window.setInterval(() => {
      void apiFetch(`/api/v1/installations/${pendingInstallationId}`, { credentials: 'same-origin' }).then(async (response) => {
        // A stopped install takes its own record away with everything else it
        // wrote, so the row this was watching is simply not there any more.
        // Without this the console sat on "Installing" for as long as it was
        // left open, over a machine on which nothing was being installed.
        if (response.status === 404) return 'gone' as const;
        return response.ok ? await response.json() as Installation : null;
      }).then((installation) => {
        if (installation === 'gone') {
          setInstalling(false);
          setPendingInstallationId(null);
          setInstallJobId(null);
          setInstallations((current) => current.filter((item) => item.id !== pendingInstallationId));
          void apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null).then((payload) => {
            if (!payload) return;
            setInstallations(payload.installations);
            setActiveInstallationId(payload.activeInstallationId);
          }).catch(() => undefined);
          return;
        }
        if (!installation) return;
        setInstallations((current) => [...current.filter((item) => item.id !== installation.id), installation]);
        if (installation.status === 'ready' || installation.status === 'failed') {
          setInstalling(false);
          setInstallJobId(null);
          // Keep the pending id so the just-finished result stays visible.
          // Refresh the active pointer after the runtime switches atomically.
          void apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null).then((payload) => {
            if (!payload) return;
            setInstallations(payload.installations);
            setActiveInstallationId(payload.activeInstallationId);
          }).catch(() => undefined);
          // An install makes the profile that goes with it.
          reloadProfiles();
        }
      }).catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [installing, pendingInstallationId]);

  /**
   * Stop the install that is running, and let the server take back what it wrote.
   *
   * The answer is not waited for here beyond the request being accepted: what
   * happens next is the same polling that was already watching the install,
   * which sees the record go and clears the card.
   */
  const cancelInstall = async (): Promise<void> => {
    if (!installJobId || !csrfToken) return;
    await apiFetch(`/api/v1/jobs/${encodeURIComponent(installJobId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
  };

  /** Whether SillyTavern comes up with the manager. Reported back so the switch can go back. */
  const setAutoStartSillyTavern = async (enabled: boolean): Promise<string | null> => {
    const response = await apiFetch('/api/v1/startup', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ autoStartSillyTavern: enabled }) });
    const payload = await response.json() as { startup?: StartupSettings; error?: { message?: string } };
    if (!response.ok || !payload.startup) return fail.body(payload, t('console.startupSaveFailed'));
    setStartup(payload.startup);
    return null;
  };

  /** Saver mode's switch. Reported back so the switch can go back. */
  const setSaverMode = async (enabled: boolean): Promise<string | null> => {
    const response = await apiFetch('/api/v1/saver', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ enabled }) });
    const payload = await response.json() as { saver?: SaverState; error?: { message?: string } };
    if (!response.ok || !payload.saver) return fail.body(payload, t('console.startupSaveFailed'));
    setSaver(payload.saver);
    return null;
  };

  /** Whether the manager keeps itself online, and how often. Reported back so the switch can go back. */
  const setKeepOnline = async (enabled: boolean, minutes: number): Promise<string | null> => {
    const response = await apiFetch('/api/v1/online', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ enabled, minutes }) });
    const payload: unknown = await response.json();
    if (!response.ok) return fail.body(payload, t('console.keepOnlineSaveFailed'));
    setOnline(payload as OnlineState);
    return null;
  };

  const navigate: Navigate = (next) => { window.location.hash = next; setPage(next); window.scrollTo({ top: 0 }); };
  const changePreferences = onPreferencesChange;
  /*
   * Whether anything has arrived in the log since it was last looked at.
   *
   * The first batch is whatever was already in the buffer when the page
   * opened, not news, so the mark starts at the newest line of it; only what
   * comes after that lights the dot. While the sheet is open the mark keeps
   * up with the tail, so closing it always leaves the dot clear.
   */
  const [seenLogId, setSeenLogId] = useState<number | null>(null);
  const newestLogId = liveLogs.entries.at(-1)?.id ?? null;
  useEffect(() => {
    if (newestLogId === null) return;
    if (seenLogId === null || logsExpanded) setSeenLogId(newestLogId);
  }, [newestLogId, logsExpanded, seenLogId]);
  const hasNewLogs = seenLogId !== null && newestLogId !== null && newestLogId > seenLogId;
  const updateRuntime = async (path: string, body?: unknown) => {
    const init: RequestInit = { method: body === undefined ? 'POST' : 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await apiFetch(path, init);
    if (!response.ok) {
      toast({ title: fail.body(await response.json().catch(() => null), t('console.actionFailed')), tone: 'destructive' });
      return;
    }
    const payload = await response.json() as ProcessState | TunnelState;
    if (path.includes('/process')) { setProcessState(payload as ProcessState); reportProcess(payload as ProcessState); }
    else { setTunnelState(payload as TunnelState); reportTunnel(payload as TunnelState); }
  };

  /*
   * Say what actually happened, not what was asked for.
   *
   * Both of these requests answer with the state they ended in - start waits
   * for SillyTavern to respond before it replies - so the confirmation can be
   * read off that rather than assumed from the button that was pressed. A
   * version that said "Started" whatever came back would be lying on the one
   * occasion the reader most needs the truth.
   */
  const reportProcess = (state: ProcessState) => {
    if (state.status === 'running') toast({ title: t('console.startDone'), tone: 'success' });
    else if (state.status === 'stopped') toast({ title: t('console.stopDone'), tone: 'success' });
    else if (state.status === 'error') toast({ title: fail.of(state.errorCode, state.error, t('console.heroFailed')), tone: 'destructive' });
  };
  const reportTunnel = (state: TunnelState) => {
    if (state.error) { toast({ title: state.error, tone: 'destructive' }); return; }
    // The address is the whole point of turning it on, so it comes with the
    // confirmation rather than only in the card behind it.
    if (state.url) toast({ title: t('console.tunnelOnDone'), description: state.url, tone: 'success' });
    else if (state.mode === 'off') toast({ title: t('console.tunnelOffDone'), tone: 'success' });
  };
  const activeInstallation = installations.find((item) => item.id === pendingInstallationId) ?? installations.find((item) => item.id === activeInstallationId) ?? installations.at(-1);
  /*
   * The version select opens on the version that is installed.
   *
   * It used to open on "latest" whatever was on the disk, so a machine pinned
   * to an older release presented the newest one as the current choice, and
   * the Install button beside it looked like it would reinstall what was
   * already there. The ref is what is matched on, not the name of the option:
   * "latest" moves, so an installed copy is only that option while the option
   * still points at it, and otherwise the pinned entry for that ref is the
   * honest answer. Keyed on the installed ref, so choosing a different version
   * to install is not undone by the next poll.
   */
  const installedRef = activeInstallation?.status === 'ready' ? activeInstallation.resolvedRef : null;
  useEffect(() => {
    if (installedRef === null) return;
    const pinned = versions.find((option) => option.ref === installedRef && option.selector !== 'latest' && option.selector !== 'release');
    const moving = versions.find((option) => option.ref === installedRef);
    setVersion(pinned?.selector ?? moving?.selector ?? activeInstallation?.selector ?? 'latest');
    // The installed ref is the only thing that should move this control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedRef, versions]);
  const removeInstallation = async (): Promise<string | null> => {
    const response = await apiFetch('/api/v1/installations', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    if (!response.ok) {
      const payload = await response.json() as { error?: { message?: string } };
      return fail.body(payload, t('console.uninstallFailed'));
    }
    setInstallations([]);
    setActiveInstallationId(null);
    setPendingInstallationId(null);
    toast({ title: t('console.uninstallDone'), tone: 'success' });
    return null;
  };
  // Where SillyTavern actually is, for every link that points at it. The config
  // document reports it too, but it is null until something is installed and
  // the addresses are shown before that.
  const sillyTavernPort = portSettings?.port ?? configDocument?.settings.port ?? DEFAULT_SILLYTAVERN_PORT;
  const logProps = { t, catalog, source: logSource, onSourceChange: setLogSource, entries: liveLogs.entries, query: logQuery, onQueryChange: setLogQuery, compact: compactLogs, onToggleCompact: () => setCompactLogs((current) => !current), onLoadOlder: liveLogs.loadOlder, hasOlder: liveLogs.hasOlder, loadingOlder: liveLogs.loadingOlder };
  const logs = <LogsPanel {...logProps} expanded={logsExpanded} onToggleExpanded={() => setLogsExpanded((current) => !current)} />;
  const updateConfig = async (input: ConfigUpdateInput): Promise<string | null> => {
    const response = await apiFetch('/api/v1/config', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(input) });
    const payload = await response.json() as { config?: ConfigDocument; process?: ProcessState; tunnel?: TunnelState; error?: { message?: string } };
    if (!response.ok || !payload.config) return fail.body(payload, t('console.configSaveFailed'));
    setConfigDocument(payload.config);
    if (payload.process) setProcessState(payload.process);
    if (payload.tunnel) setTunnelState(payload.tunnel);
    return null;
  };
  const resetConfig = async (): Promise<string | null> => {
    const response = await apiFetch('/api/v1/config/reset', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    const payload = await response.json() as { config?: ConfigDocument; process?: ProcessState; tunnel?: TunnelState; error?: { message?: string } };
    if (!response.ok || !payload.config) return fail.body(payload, t('console.configSaveFailed'));
    setConfigDocument(payload.config);
    if (payload.process) setProcessState(payload.process);
    if (payload.tunnel) setTunnelState(payload.tunnel);
    return null;
  };
  /**
   * Move SillyTavern to another port.
   *
   * The server restarts it as part of the change, so the process state comes
   * back with the answer and is adopted here rather than waited for: until it
   * does, the page would show SillyTavern as running on a port it has left.
   */
  const updateSillyTavernPort = async (port: number): Promise<string | null> => {
    const response = await apiFetch('/api/v1/config/port', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ port }) });
    const payload = await response.json() as { port?: number; process?: ProcessState; error?: { message?: string } };
    const saved = payload.port;
    if (!response.ok || typeof saved !== 'number') return fail.body(payload, t('console.portSaveFailed'));
    setPortSettings((current) => current ? { ...current, port: saved } : current);
    if (payload.process) setProcessState(payload.process);
    // The file now says the new port, and the settings card reads it from there.
    const configResponse = await apiFetch('/api/v1/config', { credentials: 'same-origin' });
    if (configResponse.ok) setConfigDocument(await configResponse.json() as ConfigDocument);
    return null;
  };
  /**
   * Open or close the console's own public link.
   *
   * Nothing is navigated here. The address takes a moment to arrive - the
   * switch reports "starting" until cloudflared announces it - and moving the
   * reader to a link that does not exist yet would land them on nothing.
   */
  const setManagerTunnel = async (on: boolean): Promise<ActionFailure | null> => {
    const response = await apiFetch('/api/v1/manager-tunnel', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: on ? 'quick' : 'off' }) });
    const payload = await response.json() as TunnelState & { error?: { code?: string; message?: string } };
    // The code travels with the sentence, because one of the refusals here has
    // an answer the card can offer rather than only describe. See ConfigPage.
    if (!response.ok) return { code: payload.error?.code ?? null, text: fail.body(payload, t('console.managerTunnelFailed')) };
    setManagerTunnelState(payload);
    return null;
  };
  const setAccessPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ password, confirmPassword }) });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.passwordSaveFailed'));
    setAccessSecurity(payload);
    toast({ title: t('console.passwordSaved'), tone: 'success' });
    return null;
  };
  const setAccessLan = async (lan: boolean): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/network', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ lan }) });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.configSaveFailed'));
    setAccessSecurity(payload);
    return null;
  };
  const signOutAccessDevices = async (): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/sessions', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.actionFailed'));
    setAccessSecurity(payload);
    toast({ title: t('console.signOutDevicesDone'), tone: 'success' });
    return null;
  };
  /**
   * Erase everything and let the manager set itself up again.
   *
   * There is nothing to update here afterwards. The password this page was
   * signed in with no longer exists, so the server has already ended the
   * session and cleared the cookie; reloading is what takes the reader to the
   * first-run screen, and it is also the only way to be sure nothing on the
   * page is still showing a profile or a backup that is gone.
   */
  /** The manager release worth a card, with the version it is newer than. */
  const newerManager = managerUpdate?.update && shouldShowManagerRelease(managerUpdate.update, dismissedManagerRelease)
    ? { current: managerUpdate.version, release: managerUpdate.update }
    : null;

  const eraseEverything = async (password: string): Promise<string | null> => {
    const response = await apiFetch('/api/v1/reset', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ password }) });
    const payload = await response.json() as { ok?: boolean; erased?: number; failures?: ReadonlyArray<{ path: string }>; error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.resetFailed'));
    const failed = payload.failures?.length ?? 0;
    toast({ title: failed > 0 ? t('console.resetPartial', { count: failed }) : t('console.resetDone'), tone: failed > 0 ? 'attention' : 'success' });
    // Long enough for the line above to be read, short enough that nobody
    // wonders whether the button worked.
    window.setTimeout(() => { window.location.reload(); }, failed > 0 ? 4000 : 1200);
    return null;
  };
  const changeManagerPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const response = await apiFetch('/api/v1/auth/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ password, confirmPassword }) });
    const payload = await response.json() as { error?: { message?: string } };
    return response.ok ? null : fail.body(payload, t('console.managerPasswordSaveFailed'));
  };
  /*
   * What the checklist on the overview needs that the status does not carry:
   * whether the console has a password of its own, and how far the cloud
   * connection has got. Both are local reads, asked when the overview is
   * opened and again when the account's R2 problem comes or goes.
   */
  const [managerPasswordSet, setManagerPasswordSet] = useState<boolean | null>(null);
  const [checklistR2, setChecklistR2] = useState<R2Config | null>(null);
  const [checklistPinOpen, setChecklistPinOpen] = useState(false);
  // The steps the manager has written down as done, and whether the reads
  // below have answered at least once.
  const [rememberedSteps, setRememberedSteps] = useState<readonly SetupStep[] | null>(null);
  const [checklistRead, setChecklistRead] = useState(false);
  useEffect(() => {
    if (page !== 'overview') return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const [session, r2, remembered] = await Promise.all([apiFetch('/api/v1/auth/session', { credentials: 'same-origin' }), apiFetch('/api/v1/r2', { credentials: 'same-origin' }), apiFetch('/api/v1/checklist', { credentials: 'same-origin' })]);
        if (cancelled) return;
        if (session.ok) setManagerPasswordSet((await session.json() as { managerPassword?: boolean }).managerPassword ?? true);
        if (r2.ok) setChecklistR2((await r2.json() as { config: R2Config }).config);
        if (remembered.ok) setRememberedSteps((await remembered.json() as SetupChecklistState).done);
      } catch {
        // The list shows what it knows; the next visit asks again.
      }
      if (!cancelled) setChecklistRead(true);
    })();
    return () => { cancelled = true; };
  }, [page, r2Problem]);
  /*
   * Take the reader to the control that does the step, and point at it.
   *
   * Scrolled to the middle of the screen rather than the top of its card, and
   * lit for a moment, so the eye lands on the button and not on the card
   * around it. Steps that have a form of their own open it here instead.
   */
  const pointAt = (target: string) => {
    // The one on screen: some controls are drawn twice, one for each width.
    const element = [...document.querySelectorAll<HTMLElement>(`[data-target="${target}"]`)].find((candidate) => candidate.offsetParent !== null) ?? document.querySelector<HTMLElement>('[data-tour="installation"]');
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.remove('flash-target');
    void element.offsetWidth;
    element.classList.add('flash-target');
    window.setTimeout(() => element.classList.remove('flash-target'), 1800);
  };
  const [checklistPasswordOpen, setChecklistPasswordOpen] = useState(false);
  // The data page opens its connection form once it has read the settings.
  const [dataIntent, setDataIntent] = useState<'connect' | null>(null);
  const openConnect = () => { setDataIntent('connect'); navigate('data'); };
  const cloudflareSignedIn = checklistR2?.cloudflare ? checklistR2.cloudflare.state === 'connected' || checklistR2.cloudflare.state === 'choose_account' : false;
  /*
   * Whether each step is done now, as far as the reads above can tell.
   *
   * Only half of the answer. They arrive one by one after a start, and a
   * step read before its answer is in looks unfinished - a SillyTavern that
   * was installed a week ago blinked back onto the list as something to do
   * every time the manager came up. So the list waits until every read has
   * answered, and a step seen done once is written down on the manager and
   * stays done from then on: finishing a step is something done once.
   */
  const checklistReady = checklistRead && installationsLoaded && securityLoaded;
  const stepsSeen: Record<SetupStep, boolean> = {
    install: activeInstallation?.status === 'ready',
    cloudflare: cloudflareSignedIn || (checklistR2?.mode === 'keys' && checklistR2.configured),
    password: managerPasswordSet === true,
    pin: accessSecurity.passwordConfigured,
    r2: Boolean(checklistR2?.configured) && r2Problem === null,
    open: accessSecurity.opened === true,
  };
  const stepDone = (step: SetupStep): boolean => stepsSeen[step] || (rememberedSteps?.includes(step) ?? false);
  const newlyDone = checklistReady ? (Object.keys(stepsSeen) as SetupStep[]).filter((step) => stepsSeen[step] && !(rememberedSteps?.includes(step) ?? false)) : [];
  const newlyDoneKey = newlyDone.join(',');
  useEffect(() => {
    if (newlyDone.length === 0) return;
    void apiFetch('/api/v1/checklist', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ done: newlyDone }) })
      .then(async (response) => { if (response.ok) setRememberedSteps((await response.json() as SetupChecklistState).done); })
      // Still shown as done here; the next visit writes it down.
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newlyDoneKey]);
  const checklistItems: ChecklistItem[] = [
    { id: 'install', label: t('console.checkInstall'), icon: <Download />, done: stepDone('install'), onSelect: () => pointAt('install') },
    { id: 'cloudflare', label: t('console.checkCloudflare'), icon: <CloudflareMark />, done: stepDone('cloudflare'), onSelect: openConnect },
    { id: 'password', label: t('console.checkManagerPassword'), icon: <ShieldCheck />, done: stepDone('password'), onSelect: () => setChecklistPasswordOpen(true) },
    { id: 'pin', label: t('console.checkPin'), icon: <KeyRound />, done: stepDone('pin'), onSelect: () => setChecklistPinOpen(true) },
    { id: 'r2', label: t('console.checkR2'), icon: <Cloud />, done: stepDone('r2'), onSelect: openConnect },
    { id: 'open', label: t('console.checkOpen'), icon: <ArrowUpRight />, done: stepDone('open'), onSelect: () => pointAt('tunnel') },
  ];
  const checklist = <>
    {checklistReady ? <SetupChecklist t={t} items={checklistItems} /> : null}
    <PasscodeDialog t={t} open={checklistPinOpen} onOpenChange={setChecklistPinOpen} note={null} onSubmit={setAccessPassword} />
    <PasswordDialog
      t={t}
      open={checklistPasswordOpen}
      onOpenChange={setChecklistPasswordOpen}
      title={managerPasswordSet === false ? t('console.managerPasswordSetTitle') : t('console.managerPasswordTitle')}
      description={t('console.managerPasswordHint')}
      minLength={MIN_MANAGER_PASSWORD}
      hint={t('console.managerPasswordMin')}
      submitLabel={managerPasswordSet === false ? t('console.managerPasswordSet') : t('console.changePassword')}
      onSubmit={async (password, confirmPassword) => {
        const failure = await changeManagerPassword(password, confirmPassword);
        if (failure) return failure;
        toast({ title: t('console.managerPasswordSaved'), tone: 'success' });
        setManagerPasswordSet(true);
        return null;
      }}
    />
  </>;
  const hero = <RuntimeCard
    t={t}
    fail={fail}
    catalog={catalog}
    process={processState}
    tunnel={tunnelState}
    security={accessSecurity}
    sillyTavernPort={sillyTavernPort}
    networkHost={accessSecurity.networkHost ?? null}
    installed={Boolean(activeInstallationId)}
    installing={installing}
    // Only while there is nothing installed, which is the window this is for.
    // A scheduled backup of a machine that is up is not news about SillyTavern
    // and does not belong on SillyTavern's card.
    recovering={activeInstallationId ? null : backgroundJob}
    canCancelInstall={installJobId !== null}
    onCancelInstall={cancelInstall}
    active={activeInstallation}
    dataBytes={systemSnapshot?.storage.dataBytes ?? null}
    profileName={profiles.find((profile) => profile.id === activeProfileId)?.name ?? null}
    version={version}
    onVersionChange={setVersion}
    versions={versions}
    onPendingInstallationId={setPendingInstallationId}
    csrfToken={csrfToken}
    onInstalling={setInstalling}
    onInstallJob={setInstallJobId}
    onRemove={removeInstallation}
    onStart={() => updateRuntime('/api/v1/process/start')}
    onStop={() => updateRuntime('/api/v1/process/stop')}
    onSetPassword={setAccessPassword}
    onPublish={() => updateRuntime('/api/v1/tunnel', { mode: 'quick' })}
    onShowAddresses={() => { document.querySelector('[data-tour="remote-access"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
    onOpenSettings={() => navigate('config')}
  />;

  return (
    <>
      <SidebarProvider style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.75rem' } as CSSProperties}>
        <AppSidebar page={page} navigate={navigate} t={t} />
        <SidebarInset className="min-w-0">
          <header className="site-header">
            <div className="site-header-inner">
              {/* The trigger is desktop-only: below `md` the destinations are
                  along the bottom of the screen, where a thumb already is. */}
              <SidebarTrigger label={t('console.toggleNavigation')} className="-ml-1 hidden size-8 shrink-0 md:inline-flex" />
              <BrandMark size={26} className="md:hidden" />
              <h1>{t(`nav.${page}`)}</h1>
              <div className="-mr-1 ml-auto flex shrink-0 items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="log-header-button"
                  aria-label={hasNewLogs ? `${t('console.openLogs')} · ${t('console.newLogs')}` : undefined}
                  onClick={() => setLogsExpanded(true)}
                ><ScrollText />{t('console.openLogs')}{hasNewLogs ? <span className="log-new-dot" aria-hidden="true" /> : null}</Button>
                <LanguageControl t={t} preferences={preferences} onChange={changePreferences} />
                <Button variant="ghost" size="icon-sm" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => changePreferences({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
                  {preferences.theme === 'dark' ? <Sun /> : <Moon />}
                </Button>
              </div>
            </div>
          </header>
          <PageContainer>
            {/* Left out in two places: the Data page, which shows this work
                under the card it belongs to with the Stop button beside it,
                and the Overview of a machine with nothing installed, where the
                SillyTavern card is already saying it in place of its Install
                button. */}
            {/* The account has been taken by another manager, so this one
                has stopped backing up. First of everything, because nothing
                else on the page is true while it is. */}
            {displaced && r2Owner && shouldShowDisplaced(r2Owner.label, dismissedDisplaced)
              ? <div className="mb-(--section-gap)"><Alert variant="destructive">
                <ShieldCheck />
                <AlertTitle>{t('console.r2DisplacedTitle')}</AlertTitle>
                <AlertDescription className="grid gap-2">
                  <span>{t('console.r2DisplacedBody', { name: r2Owner.label, when: new Date(r2Owner.lastSeenAt).toLocaleString() })}</span>
                  <span className="flex flex-wrap items-center gap-2">{reconnectUrl
                    ? <Button size="sm" asChild style={{ backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' }} className="hover:opacity-90">
                      <a href={reconnectUrl} target="_blank" rel="noopener noreferrer"><CloudflareMark />{t('console.r2DisplacedSignIn')}</a>
                    </Button>
                    : <Button size="sm" style={{ backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' }} className="hover:opacity-90" onClick={() => signInToCloudflareAgain()}><CloudflareMark />{t('console.r2DisplacedSignIn')}</Button>}
                  {/* Somebody who has moved to the other machine on purpose is
                      being told the same thing on every page for good. The
                      backup card goes on saying it where it matters. */}
                  <Button size="sm" variant="ghost" onClick={() => {
                    saveDismissedDisplaced(r2Owner.label, browserStorage());
                    setDismissedDisplaced(r2Owner.label);
                  }}>{t('common.dismiss')}</Button></span>
                </AlertDescription>
              </Alert></div>
              : null}
            {/* Nowhere for a backup to go, and the way to fix it is not on
                this machine at all. Above everything for as long as it is
                true, because for as long as it is true nothing is being
                kept anywhere but here. */}
            {r2Problem === 'r2_not_enabled'
              ? <div className="mb-(--section-gap)"><Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>{t('console.cfR2NotEnabledTitle')}</AlertTitle>
                <AlertDescription className="grid gap-2">
                  <span>{t('console.cfR2NotEnabledBody')}</span>
                  <R2ActivationActions t={t} onRecheck={recheckR2} />
                </AlertDescription>
              </Alert></div>
              : null}
            {/* Below the two above it, which are about data that is not being
                kept anywhere, and above everything else. It is the only card
                here that asks the reader a question about their own agreement,
                and it stays until they answer it - but it blocks nothing while
                it waits. */}
            {legalReview?.required
              ? <div className="mb-(--section-gap)"><LegalReviewCard
                t={t}
                locale={preferences.locale}
                review={legalReview}
                busy={legalBusy}
                failure={legalFailure}
                checked={legalAgreed}
                nudges={legalNudges}
                onCheckedChange={setLegalAgreed}
                onAccept={() => void acknowledgeLegal()}
                onOpenDocument={(document) => { setReviewLegalDocument(document); setReviewLegalOpen(true); }}
              /></div>
              : null}
            {/* Above the work, and above the page, because on a machine
                that has just been put in front of somebody this is the whole
                of what there is to do. */}
            {/* Not while this machine has been locked out of the account:
                what is in there cannot be read from here, and offering to
                rebuild this machine out of it is offering a button that
                cannot work. Signing in again is the only step there is, and
                the notice above is where it is. */}
            {!displaced && backgroundJob === null && shouldOfferSettings(settingsOffer, dismissedSettings) && settingsOffer
              ? <div className="mb-(--section-gap)"><RestoreEverythingCard
                t={t}
                offer={settingsOffer}
                busy={restoringEverything || backgroundJob !== null}
                onRestore={() => void restoreEverything()}
                onDismiss={() => {
                  const when = settingsOffer.writtenAt;
                  if (!when) return;
                  saveDismissedSettings(when, browserStorage());
                  setDismissedSettings(when);
                  /*
                   * And the manager is told, because more than this card is
                   * waiting on it: nothing of this machine's goes up to the
                   * account until somebody has said what to do with what is
                   * already there. Not waited for - the card is answered
                   * either way, and the next tick asks again.
                   */
                  void apiFetch('/api/v1/r2/settings/dismiss', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
                }}
              /></div>
              : null}
            {backgroundJob && page !== 'data' && !(page === 'overview' && !activeInstallationId)
              ? <div className="mb-(--section-gap)"><BackgroundTaskCard t={t} catalog={catalog} job={backgroundJob} /></div>
              : null}
            {/* Below the work and below anything broken, because a release
                that exists will still exist in ten minutes. On every page
                rather than the Overview alone: whichever page somebody is on
                is the one they will read it from, and it is dismissed once. */}
            {newerManager
              ? <div className="mb-(--section-gap)"><ManagerReleaseCard
                t={t}
                locale={preferences.locale}
                current={newerManager.current}
                release={newerManager.release}
                onDismiss={() => {
                  saveDismissedManagerRelease(newerManager.release.version, browserStorage());
                  setDismissedManagerRelease(newerManager.release.version);
                }}
              /></div>
              : null}
            {page === 'overview' ? <div className="grid min-w-0 gap-(--section-gap)">{hero}{checklist}<AccessPanel t={t} process={processState} tunnel={tunnelState} config={configDocument} security={accessSecurity} sillyTavernPort={sillyTavernPort} onAction={updateRuntime} onSetLan={setAccessLan} onSetPassword={setAccessPassword} /><CardGrid columns={2}><DataPanel t={t} navigate={navigate} latestBackup={backups.at(-1) ?? null} snapshot={systemSnapshot} onRemeasure={remeasure} /><SystemPanel t={t} snapshot={systemSnapshot} />{logs}</CardGrid></div> : page === 'data' ? <DataPage t={t} locale={preferences.locale} fail={fail} catalog={catalog} csrfToken={csrfToken} profiles={profiles} activeProfileId={activeProfileId} backups={backups} onProfilesChange={(next, active) => { setProfiles(next); setActiveProfileId(active); }} onBackupsChange={setBackups} intent={dataIntent} onIntentHandled={() => setDataIntent(null)} /> : page === 'metrics' ? <MetricsPage t={t} /> : page === 'config' ? <ConfigPage t={t} locale={preferences.locale} config={configDocument} security={accessSecurity} ports={portSettings} managerTunnel={managerTunnelState} onSetManagerTunnel={setManagerTunnel} startup={startup} saver={saver} online={online} onSetAutoStart={setAutoStartSillyTavern} onSetSaver={setSaverMode} onSetKeepOnline={setKeepOnline} onPortChange={updateSillyTavernPort} onConfigUpdate={updateConfig} onConfigReset={resetConfig} process={processState} catalog={catalog} onChangeManagerPassword={changeManagerPassword} onSetPassword={setAccessPassword} onSignOut={onSignOut} onSignOutDevices={signOutAccessDevices} onEraseEverything={eraseEverything} /> : <ResourcePanel page={page} t={t} />}
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
      {/* The full text, for the card above that asks about it. Mounted here
          rather than inside the card so that the documents open over whichever
          page the reader is on, and separate from the Settings page's own copy
          because that one belongs to the About panel and its state. */}
      <LegalDialog
        t={t}
        locale={preferences.locale}
        open={reviewLegalOpen}
        onOpenChange={setReviewLegalOpen}
        document={reviewLegalDocument}
        onDocumentChange={setReviewLegalDocument}
      />
    </>
  );
}

/**
 * Everything this account remembers about a machine, offered in one press.
 *
 * It used to take three, spread over two pages and a table: restore the
 * settings from a notice under the backup list, notice that they named a
 * release and go and install it, then find the newest recovery point among the
 * rows and restore that. Each was a separate decision, each on a card somebody
 * had to already know was there, and the one page they were on is the one page
 * a reader has no reason to open until something has already gone wrong.
 *
 * So it is one card, at the top of whatever page they are looking at. What it
 * does is listed rather than summarised, because the reader is being asked to
 * let a machine be replaced by the memory of another one, and the console's
 * password is in that memory.
 */
function RestoreEverythingCard({ t, offer, busy, onRestore, onDismiss }: {
  t: Translate;
  offer: ManagerSettingsOffer;
  busy: boolean;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return <Card className="cloud-card">
    <PanelHeading icon={<History />}>{t('console.r2RestoreAllTitle')}</PanelHeading>
    <CardContent className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {t('console.r2RestoreAllBody', { name: offer.label ?? '', when: offer.writtenAt ? new Date(offer.writtenAt).toLocaleString() : '' })}
      </p>
      <ul className="grid gap-1 text-sm text-muted-foreground">
        <li>{t('console.r2RestoreAllData')}</li>
        <li>{t('console.r2RestoreAllVersion')}</li>
        <li>{t('console.r2RestoreAllSettings')}</li>
        <li>{t('console.r2RestoreAllMetrics')}</li>
      </ul>
      <p className="text-xs text-muted-foreground">{t('console.r2RestoreAllSafety')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onRestore} loading={busy}><History />{t('console.r2RestoreAll')}</Button>
        {/* Saying no is an answer. Without it this is a card about somebody
            else's machine that stays on every page for good. */}
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy}>{t('console.r2SettingsDismiss')}</Button>
      </div>
    </CardContent>
  </Card>;
}

/**
 * The terms have been revised, and the reader has not been asked about it.
 *
 * The documents ship compiled into the program, so a manager that has just
 * been updated is holding wording its reader has never seen - and nothing
 * about that is visible from inside the console. This is the one screen that
 * says so.
 *
 * What it asks for is an acknowledgement, and it behaves like one. It carries
 * the short account of what the revision says, opens the full text beside it,
 * and stays on every page until it is answered - but it locks nothing and
 * erases nothing while it waits. Holding somebody's chats hostage over a
 * checkbox would be a worse thing to do than anything in the documents.
 */
function LegalReviewCard({ t, locale, review, busy, failure, checked, nudges, onCheckedChange, onAccept, onOpenDocument }: {
  t: Translate;
  locale: LocaleCode;
  review: LegalReview;
  busy: boolean;
  failure: string | null;
  checked: boolean;
  nudges: number;
  onCheckedChange: (checked: boolean) => void;
  onAccept: () => void;
  onOpenDocument: (document: LegalDocumentId) => void;
}) {
  const notes = legalRevision(locale);
  return <Card className="notice-card">
    <PanelHeading icon={<Scale />}>{t('console.legalReviewTitle')}</PanelHeading>
    <CardContent className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {t('console.legalReviewBody', { revision: review.revision, date: releaseDate(`${review.effective}T00:00:00Z`, locale) })}
      </p>
      <div className="notice-changes">
        <p className="notice-changes-summary">{notes.summary}</p>
        <ul>
          {notes.changes.map((change, index) => <li key={index}>{change}</li>)}
        </ul>
      </div>
      <TermsConsent
        t={t}
        locale={locale}
        id="legal-review-consent"
        sentence="console.legalReviewAgree"
        nudges={nudges}
        checked={checked}
        onCheckedChange={onCheckedChange}
        onOpenDocument={onOpenDocument}
      />
      {failure ? <p className="install-error" role="alert">{failure}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onAccept} loading={busy}>{t('console.legalReviewAccept')}</Button>
      </div>
    </CardContent>
  </Card>;
}

/**
 * A newer manager than the one being looked at, and what it says it changed.
 *
 * There is no button here that installs it, and that is deliberate. The
 * manager is on the machine in one of three shapes - a checkout, a package
 * from npm, a bundle on Windows - each replaced its own way, and a console
 * that tried to overwrite the program it is itself running is the one upgrade
 * that can leave a machine with neither version. So this says a new one
 * exists, shows what the release said about itself, and links to it.
 *
 * The notes are the release's own text, printed as written. Whoever cut the
 * release wrote its line breaks on purpose, and a card that reflows them into
 * a paragraph turns a list of changes into a run-on sentence.
 */
function ManagerReleaseCard({ t, locale, current, release, onDismiss }: {
  t: Translate;
  locale: LocaleCode;
  /**
   * The version actually running, as the manager reports it.
   *
   * Not `__STM_VERSION__`, which is the version the panel was built at. They
   * agree in every shipped build and disagree in exactly the case worth being
   * right about - a panel served by a manager it was not built alongside -
   * and the running one is what the comparison behind this card was made
   * against.
   */
  current: string;
  release: ManagerRelease;
  onDismiss: () => void;
}) {
  return <Card className="release-card">
    <PanelHeading icon={<CircleArrowUp />}>{t('console.managerUpdateTitle', { version: release.version })}</PanelHeading>
    <CardContent className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {t('console.managerUpdateBody', { current, version: release.version })}
        {release.publishedAt ? ` ${t('console.managerUpdatePublished', { when: releaseDate(release.publishedAt, locale) })}` : ''}
      </p>
      {release.notes
        ? <div className="release-notes">
          {release.name ? <p className="release-notes-title">{release.name}</p> : null}
          <p className="release-notes-body">{release.notes}</p>
        </div>
        : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" asChild>
          <a href={release.url} target="_blank" rel="noreferrer noopener">
            <ArrowUpRight />{t('console.managerUpdateOpen')}
          </a>
        </Button>
        {/* Saying no is an answer, and it is remembered against this version:
            the next release is a different one and says so again. */}
        <Button size="sm" variant="ghost" onClick={onDismiss}>{t('console.updateDismiss')}</Button>
      </div>
    </CardContent>
  </Card>;
}

/** The day a release was published, written the way the reader writes dates. */
function releaseDate(iso: string, locale: LocaleCode): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  } catch {
    return iso;
  }
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

/**
 * Which language is on, and one press to change it.
 *
 * This was a pair of buttons in a bordered track, which made it the tallest
 * thing in a header of 32px controls and read as a setting with two answers
 * when there are only ever two and one of them is already in force. The
 * button shows the language being read; pressing it says so in the other.
 */
function LanguageControl({ t, preferences, onChange }: { t: Translate; preferences: Preferences; onChange: (value: Partial<Preferences>) => void }) {
  const next: LocaleCode = preferences.locale === 'vi' ? 'en' : 'vi';
  const label = t(next === 'vi' ? 'console.switchToVietnamese' : 'console.switchToEnglish');
  return <Button
    variant="outline"
    size="icon-sm"
    className="language-toggle"
    aria-label={label}
    title={label}
    onClick={() => onChange({ locale: next })}
  >{preferences.locale.toUpperCase()}</Button>;
}

function PanelHeading({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  // Centred on each other: the title is a line of text and the actions are
  // buttons taller than it, and lined up by their tops the buttons sat low.
  return <CardHeader className="grid-rows-[auto] items-center"><h2 className="panel-title">{icon}{children}</h2>{action ? <CardAction className="row-span-1 self-center">{action}</CardAction> : null}</CardHeader>;
}

/**
 * A state, said in a word and in a colour, wherever a state is reported.
 *
 * The dot is never the only carrier: the word beside it always says the same
 * thing, because a colour alone is no use to a reader who cannot separate
 * green from amber and no use at all to a screen reader. The colours are the
 * semantic ones - green for up, amber for needs-attention, the accent for work
 * in progress - rather than the accent doing all three jobs.
 */
function StatePill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`state-pill state-pill-${tone}`}>
    <span aria-hidden="true" className="state-dot" />
    {children}
  </span>;
}

/**
 * A still of SillyTavern's layout, drawn rather than photographed.
 *
 * Deliberately a placeholder and not a screenshot: there is no headless
 * browser here to photograph the real thing, and a stale picture of somebody
 * else's chat would be worse than an honest diagram. What it carries is the
 * shape - characters down the left, the conversation in the middle, the
 * generation settings on the right - which is enough to recognise what is
 * behind the button sitting on top of it.
 */
interface PreviewManifest {
  readonly background: string | null;
  readonly theme: {
    readonly text: string | null; readonly quote: string | null; readonly tint: string | null;
    readonly userTint: string | null; readonly botTint: string | null; readonly border: string | null;
    readonly chatWidth: number | null;
  } | null;
  readonly recent: readonly { readonly name: string; readonly avatar: string | null; readonly at: string }[];
}

/** The width the still is drawn at before it is scaled into whatever box it gets. */
const STILL_WIDTH = 640;

/**
 * A preview picture, fetched rather than linked.
 *
 * These are the reader's own files - their wallpaper, their characters - and
 * the manager will not hand them to somebody who is not signed in. A browser
 * asking for an `<img src>` sends the cookie and nothing else, which is fine
 * until the console is a document inside another site's page: the cookie is a
 * third-party cookie there, and where it is not stored the whole preview comes
 * back 401 and the panel draws an empty frame.
 *
 * So these go through `apiFetch` like every other call, which carries the
 * session however this console is holding it, and what reaches the `<img>` is
 * a blob of bytes already in hand. The other way out would be to put the token
 * in the address - which puts a live credential in the page source, the
 * browser's history and every access log between here and there.
 *
 * `name` is null for a picture there is nothing to fetch yet, so a preview
 * still loading does not ask the manager for a file with no name.
 */
function usePreviewImage(kind: 'background' | 'avatar' | 'logo', name?: string | null): string | null {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    setSource(null);
    if (name === null) return undefined;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const query = name === undefined ? `kind=${kind}` : `kind=${kind}&name=${encodeURIComponent(name)}`;
    void apiFetch(`/api/v1/preview/image?${query}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => response.ok ? await response.blob() : null)
      .then((bytes) => {
        if (!bytes || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(bytes);
        setSource(objectUrl);
      })
      .catch(() => undefined);
    // Handed back, or the tab holds every wallpaper it has drawn until reload.
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [kind, name]);
  return source;
}

/**
 * One of those pictures, or a shape the same size while it is not there.
 *
 * Never a broken-image icon and never a hole: the still is a drawing of an
 * interface, and a file that is missing or still arriving should leave the
 * drawing looking the way it does when that part of it is simply empty.
 */
function PreviewImage({ kind, name, className, placeholder }: { kind: 'background' | 'avatar' | 'logo'; name?: string | null; className: string; placeholder?: string }) {
  const source = usePreviewImage(kind, name);
  return source ? <img className={className} src={source} alt="" /> : <i className={placeholder ?? className} />;
}

/**
 * SillyTavern's own front page, redrawn small.
 *
 * Not a screenshot - there is no headless browser here to take one - but not a
 * generic drawing either: the wallpaper, the theme colours and the characters
 * in the Recent Chats list are the reader's own, read off their profile. What
 * is invented is only the shape, and the shape is the one SillyTavern actually
 * opens with: nine icons along the top, both side drawers shut, a single
 * column of chat down the middle at the width they set, the recent list, and
 * the assistant's greeting under it.
 *
 * Drawn at a fixed size and scaled into its box, so the proportions stay right
 * at any width instead of reflowing into a layout SillyTavern never has. The
 * message bodies are blank bars because no chat file is ever read to draw
 * this - a picture on a dashboard is not worth opening conversations for.
 */
function SillyTavernStill({ generation }: { generation: string }) {
  const [manifest, setManifest] = useState<PreviewManifest | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);
  // Read once per run of SillyTavern. None of it changes while it is up, and
  // the wallpaper is a megabyte nobody needs fetched on a timer.
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/v1/preview', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => response.ok ? await response.json() as PreviewManifest : null)
      .then((payload) => { if (payload && !controller.signal.aborted) setManifest(payload); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [generation]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    const fit = () => { if (element.clientWidth > 0) setScale(element.clientWidth / STILL_WIDTH); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Once, for the two places it is drawn.
  const logo = usePreviewImage('logo');
  const theme = manifest?.theme ?? null;
  const rows = manifest?.recent ?? [];
  const width = theme?.chatWidth ?? 50;
  const style = {
    '--st-text': theme?.text ?? 'rgba(220, 224, 232, 1)',
    '--st-quote': theme?.quote ?? 'rgba(165, 140, 115, 1)',
    '--st-tint': theme?.tint ?? 'rgba(30, 30, 36, 0.85)',
    '--st-bot-tint': theme?.botTint ?? 'rgba(34, 30, 32, 0.75)',
    '--st-border': theme?.border ?? 'rgba(80, 80, 80, 0.89)',
    '--st-column': `${Math.max(30, Math.min(92, width))}%`,
    transform: `scale(${scale})`,
  } as CSSProperties;

  return <div className="st-still" ref={frame} aria-hidden="true">
    <PreviewImage kind="background" name={manifest?.background ?? null} className="st-still-bg" />
    {/*
      * One column, the width SillyTavern is set to, running the whole height
      * of the window - the toolbar is the top of that column rather than a
      * band across the window, and the wallpaper shows either side of it and
      * through the empty part of the conversation below.
      */}
    <div className="st-still-scale" style={style}>
      <div className="st-still-column">
        <div className="st-still-top">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div>
        <div className="st-still-panel">
          <div className="st-still-head">
            {logo ? <img className="st-still-logo" src={logo} alt="" /> : <i className="st-still-logo" />}
            <b />
            <span className="st-still-chips"><i /><i /><i /><i /></span>
          </div>
          <span className="st-still-section" />
          {[0, 1, 2].map((index) => {
            const row = rows[index];
            return <div key={index} className="st-still-recent">
              <PreviewImage kind="avatar" name={row?.avatar ?? null} className="st-still-avatar" placeholder="st-still-blank" />
              <span className="st-still-lines">
                <b style={{ width: `${40 + index * 14}%` }} />
                <u style={{ width: `${86 - index * 11}%` }} />
              </span>
            </div>;
          })}
          <span className="st-still-more" />
        </div>
        <div className="st-still-message">
          {logo ? <img className="st-still-avatar" src={logo} alt="" /> : <i className="st-still-avatar" />}
          <span className="st-still-lines">
            <b style={{ width: '34%' }} />
            <u style={{ width: '82%' }} />
            <u style={{ width: '58%' }} />
          </span>
        </div>
        <div className="st-still-actions"><i /><i /><i /></div>
        <div className="st-still-gap" />
        <div className="st-still-foot">
          <span className="st-still-links"><i /><i /><i /></span>
          <em />
        </div>
      </div>
    </div>
  </div>;
}

function Unavailable({ t, children }: { t: Translate; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md" aria-label={t('console.unavailable')}>{children}</span></TooltipTrigger><TooltipContent>{t('console.unavailable')}</TooltipContent></Tooltip>;
}

/**
 * The card the overview opens with, and everything about the running copy.
 *
 * The page used to begin with a status banner, and then, three cards later,
 * offer a version select in a card of its own headed "SillyTavern" - so the
 * thing that says whether SillyTavern is up and the thing that decides which
 * SillyTavern is up were separated by two unrelated cards. Both are here: the
 * state at the top, what it is running underneath it, and the preview of the
 * thing itself beside them.
 *
 * Start is a plain button; Stop is a destructive one and asks first, because
 * whoever is reading a chat through the public link is not in the room to be
 * consulted, and because the colour is the last chance to notice which of the
 * two buttons the pointer is over.
 */
function RuntimeCard({
  t, fail, catalog, process, tunnel, security, sillyTavernPort, networkHost, installed, installing, recovering, active, dataBytes, profileName,
  version, onVersionChange, versions, onPendingInstallationId, csrfToken, onInstalling, onInstallJob, onRemove,
  canCancelInstall, onCancelInstall,
  onStart, onStop, onSetPassword, onPublish, onShowAddresses, onOpenSettings,
}: {
  t: Translate; fail: Fail; catalog: Record<string, unknown>; process: ProcessState; tunnel: TunnelState;
  security: AccessGatewayState; sillyTavernPort: number; networkHost: string | null; installed: boolean; installing: boolean;
  /**
   * Work this machine started for itself, or null.
   *
   * On this card because of the seconds right after a Cloudflare sign-in: the
   * console reloads onto the Overview while the manager is still reading the
   * account, and what it showed was "not installed" with a live Install button
   * - offered to the one person who has just asked for the machine to put
   * itself back together, and who would therefore press it.
   */
  recovering: Job | null;
  active: Installation | undefined; dataBytes: number | null; profileName: string | null; version: string;
  onVersionChange: (value: string) => void; versions: VersionOption[];
  onPendingInstallationId: (value: string | null) => void; csrfToken: string | null;
  onInstalling: (value: boolean) => void; onInstallJob: (value: string | null) => void; onRemove: () => Promise<string | null>;
  /** Whether the install in flight is one the server will take back. */
  canCancelInstall: boolean;
  onCancelInstall: () => Promise<void>;
  onStart: () => Promise<void>; onStop: () => Promise<void>;
  onSetPassword: (password: string, confirmPassword: string) => Promise<string | null>;
  /** Turn the tunnel on, for a reader who has no address that reaches this machine. */
  onPublish: () => Promise<void>;
  onShowAddresses: () => void;
  onOpenSettings: () => void;
}) {
  const [stopAsked, setStopAsked] = useState(false);
  // What setting the PIN was the condition for: a link, or the tools window.
  const [afterPasscode, setAfterPasscode] = useState<'publish' | 'tools'>('publish');
  // Asked for on the way to a link, not before: the PIN is what the tunnel
  // needs, and it means something at the moment the door is about to open.
  const [passcodeAsked, setPasscodeAsked] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [askedVersion, setAskedVersion] = useState<string | null>(null);
  const [askedRemove, setAskedRemove] = useState(false);
  const [askedStopInstall, setAskedStopInstall] = useState(false);
  const [stoppingInstall, setStoppingInstall] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  // Opened once, kept mounted: coming back to the console and going in again
  // should not reload SillyTavern and lose whatever was half typed.
  const [embedMounted, setEmbedMounted] = useState(false);
  const [embedOpening, setEmbedOpening] = useState(false);
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(() => readDismissedUpdate(browserStorage()));
  const { toast } = useToast();
  const report = (message: string | null) => { if (message) toast({ title: message, tone: 'destructive' }); };

  const running = process.status === 'running';
  const pending = busy || process.status === 'starting' || process.status === 'stopping';
  const installingNow = installing || (active !== undefined && active.status !== 'ready' && active.status !== 'failed');
  const installFailed = active?.status === 'failed';

  const tone: StatusTone = installingNow || process.status === 'starting' || process.status === 'stopping'
    ? 'working'
    : running ? 'online'
      : process.status === 'error' || installFailed ? 'attention'
        : 'offline';

  // The card is headed with the name of the thing; the state is a pill beside
  // it, in a word. The heading used to be the whole sentence, which made the
  // one fixed thing on the page - what this card is about - move and change
  // length every time the state did.
  const stateWord = installingNow ? t('console.stateInstalling')
    : installFailed ? t('console.stateInstallFailed')
      : process.status === 'starting' ? t('console.stateStarting')
        : process.status === 'stopping' ? t('console.stateStopping')
          : process.status === 'error' ? t('console.stateError')
            : running ? t('console.stateRunning')
              : installed ? t('console.stateStopped')
                : t('console.stateNotInstalled');
  // What is being waited for, while something is being waited for. This is
  // where the sweep lives for a start or a stop - the two things somebody
  // presses and then watches, and which used to report nothing at all until
  // they finished.
  // Read off SillyTavern's own output while it starts, so a slow start says
  // what it is slow at - compiling, migrating, loading plugins.
  const processStep = process.stepCode ? translateStep('', catalog, process.stepCode, process.stepParams) : '';
  const waitingFor = process.status === 'starting' ? processStep || t('console.waitingForSilly')
    : process.status === 'stopping' ? processStep || t('console.stoppingSilly')
      : null;
  const waitingTask = process.status === 'starting' ? t('console.taskStart') : t('console.taskStop');

  // A refusal the manager wrote is said in the reader's language; a line from
  // git, npm or SillyTavern itself is shown as that program wrote it.
  const failure = installFailed && active?.error
    ? fail.of(active.errorCode, active.error, t('console.heroInstallFailed'))
    : process.error
      ? fail.of(process.errorCode, process.error, t('console.heroFailed'))
      : null;

  const choices = versions.length > 0 ? versions : [{ selector: 'latest', label: `${t('dashboard.latest')} (latest)`, ref: 'latest', channel: 'release', tag: null, publishedAt: null }] satisfies VersionOption[];
  const chosen = choices.find((choice) => choice.selector === version);
  const chosenLabel = chosen?.label ?? version;
  /*
   * Whether pressing Install would do nothing. Compared on the ref each option
   * resolves to, not on the name of the option: "latest" is a moving target,
   * so matching on the word would lock the one choice most people leave
   * selected and no upstream release could ever be installed.
   */
  const installedRef = active?.status === 'ready' ? active.resolvedRef : null;
  const alreadyInstalled = installedRef !== null && chosen !== undefined && chosen.ref === installedRef;
  const update = availableUpdate(choices, active ?? null);
  const showUpdate = update !== null && update.ref !== dismissedUpdate && !installingNow;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };

  const install = async () => {
    if (!csrfToken) return;
    onInstalling(true);
    try {
      const response = await apiFetch('/api/v1/installations', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ version }) });
      const payload = await response.json() as { installationId?: string; job?: { id?: string }; error?: { message?: string } };
      if (!response.ok) { report(fail.body(payload, t('console.installRequestFailed'))); onInstalling(false); return; }
      if (!payload.installationId) { report(t('console.installRequestFailed')); onInstalling(false); return; }
      onPendingInstallationId(payload.installationId);
      // The job, not the installation: stopping is asked of the job, and the
      // record the installation lives in is one of the things a stop removes.
      onInstallJob(payload.job?.id ?? null);
    } catch { report(t('console.installRequestFailed')); onInstalling(false); }
  };

  // The first install has nothing to interrupt. Every one after it replaces a
  // working copy and restarts it, which is worth a question.
  const requestInstall = () => { if (installed || running) setAskedVersion(version); else void install(); };
  // Asked about, because what is being given up is however many minutes of
  // downloading have already been spent.
  const stopInstall = () => { setAskedStopInstall(true); };
  const takeUpdate = () => { if (update) { onVersionChange('latest'); setAskedVersion('latest'); } };
  const dismissUpdate = () => {
    if (!update) return;
    saveDismissedUpdate(update.ref, browserStorage());
    setDismissedUpdate(update.ref);
  };

  /*
   * Whether SillyTavern can be shown inside this page at all.
   *
   * It cannot be framed directly: it answers with `X-Frame-Options:
   * SAMEORIGIN`, and the console is a different port and so a different
   * origin. What is framed is the manager's own gateway, which proxies to it
   * and says instead that this console may frame it - so the embed needs the
   * gateway up, and the gateway needs its PIN set before it lets anyone past.
   *
   * Only from this machine, and that is not a gap waiting to be filled.
   * Reached over the network the console is on some other origin, which the
   * gateway has not been told to allow; and reached through the two Workers
   * the console and the gateway are two different hostnames, so the session
   * cookie the embed relies on would be a third-party cookie inside a
   * cross-site frame - blocked outright by Safari and Firefox, and by Chrome
   * before long. A feature that works in one browser and fails silently in
   * the rest is worse than the tab this falls back to, which works in all of
   * them. The box below says so by offering that instead.
   */
  const onThisMachine = isThisMachine(window.location.hostname);
  const embedUrl = `http://${window.location.hostname}:${security.port}/`;
  const canEmbed = running && onThisMachine;
  // A frame kept loaded across a stop would come back to an error page.
  useEffect(() => { if (!running) { setEmbedOpen(false); setEmbedMounted(false); } }, [running]);
  /*
   * Open it without asking for the PIN.
   *
   * Whoever is reading this page gave the console's password, and that is the
   * stronger credential: it can stop SillyTavern, reach its data and change
   * the PIN itself. The console asks the gateway for a session on their
   * behalf; the cookie it sets is host-scoped, and cookies ignore ports, so
   * the frame on the gateway's port arrives already signed in.
   */
  const openEmbed = async () => {
    // Put away rather than closed: it is still loaded, so it only has to be shown.
    if (embedMounted) { setEmbedOpen(true); return; }
    if (!csrfToken) return;
    setEmbedOpening(true);
    try {
      const response = await apiFetch('/api/v1/access/embed-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { report(fail.body(await response.json().catch(() => null), t('console.embedFailed'))); return; }
      setEmbedMounted(true);
      setEmbedOpen(true);
    } catch { report(t('console.embedFailed')); } finally { setEmbedOpening(false); }
  };

  const addresses = reachableAddresses(tunnel, security, networkHost, sillyTavernPort, onThisMachine);
  /*
   * The best address there is, or none at all.
   *
   * None is what a hosted console has before anything is published: the
   * loopback address belongs to a container nobody can reach, the network
   * address is off, and there is no tunnel yet. This used to fall back on the
   * loopback address and offer it as the way in, which from the reader's
   * browser is their own machine - a link that opens a connection refused.
   */
  const primary = addresses[0] ?? null;
  const otherCount = Math.max(0, addresses.length - 1);
  const openPrimary = () => { if (primary) window.open(primary.url, '_blank', 'noopener,noreferrer'); };
  /*
   * SillyTavern in a tab of its own, with the tools window around it.
   *
   * The window is served by the door, on the same address as SillyTavern, so
   * it goes wherever the best address goes - except on this machine, where
   * that address is SillyTavern's own port and the window is on the door's.
   * There the console signs the tab in first, the way the embedded view is
   * signed in: the cookie is host-scoped, and cookies ignore ports.
   *
   * The tab is opened before anything is awaited, while the press still
   * counts as one, and pointed at the window once it is ready.
   */
  const openTools = async () => {
    if (!primary) return;
    if (!security.passwordConfigured) { setAfterPasscode('tools'); setPasscodeAsked(true); return; }
    const local = primary.kind === 'local';
    const target = local
      ? `http://${window.location.hostname}:${security.port}/__stm/window`
      : `${primary.url.replace(/\/$/u, '')}/__stm/window`;
    const tab = window.open('about:blank', '_blank');
    if (!tab) { window.location.assign(target); return; }
    tab.opener = null;
    if (local && csrfToken) {
      try { await apiFetch('/api/v1/access/embed-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }); } catch { /* the door asks for the PIN instead */ }
    }
    tab.location.href = target;
  };
  // A phone cannot open this machine's loopback address, so the code is only
  // offered for an address it can reach.
  const phoneAddress = primary && primary.kind !== 'local' ? primary : null;
  /*
   * Give the reader a link to SillyTavern, doing whatever that takes.
   *
   * The tunnel publishes the gateway, and the gateway will not open without a
   * PIN, so those are the two steps - asked for here, in that order, off one
   * press. Telling somebody on a hosted studio that their only address is one
   * they cannot use, and leaving them to find the switch, is how a console
   * ends up looking broken.
   */
  const publish = async () => {
    if (!security.passwordConfigured) { setAfterPasscode('publish'); setPasscodeAsked(true); return; }
    setPublishing(true);
    try { await onPublish(); } finally { setPublishing(false); }
  };
  const waitingForLink = running && primary === null;

  const runtimeActions = installed ? <>
            {waitingForLink
              ? <Button variant="outline" size="sm" onClick={() => publish()} loading={publishing || tunnel.mode !== 'off'}><Globe2 />{t('console.getLink')}</Button>
              : <ButtonGroup className="open-group" data-target="open">
                <Button size="sm" className="open-group-main" disabled={!running || primary === null} onClick={openPrimary}>{t('console.openSillyTavern')}</Button>
                <ButtonGroupSeparator />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" disabled={!running || primary === null} aria-label={t('console.openMore')}><ChevronDown /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" collisionPadding={12} className="w-72 max-w-[calc(100vw-24px)]">
                    <DropdownMenuItem onSelect={() => void openTools()} className="items-start gap-3 py-2">
                      <AppWindow className="mt-0.5" />
                      <span className="grid gap-0.5">
                        <span className="font-medium">{t('console.openWithTools')}</span>
                        <span className="text-xs text-muted-foreground">{t('console.openWithToolsHint')}</span>
                      </span>
                    </DropdownMenuItem>
                    {/* A way onto a phone, the same address the button opens -
                        and nothing at all where that address is this
                        machine's own, which no phone can reach. */}
                    {phoneAddress ? <>
                      <DropdownMenuSeparator />
                      <div className="grid justify-items-center gap-2 px-2 pt-2 pb-3 text-center">
                        <div className="rounded-lg bg-white p-2"><QrCode value={phoneAddress.url} label={t('console.scanToOpenSillyTavern')} size={152} /></div>
                        <p className="text-xs text-muted-foreground">{t('console.scanToOpenSillyTavern')}</p>
                      </div>
                    </> : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </ButtonGroup>}
            {running
              ? <Button variant="destructive" size="sm" onClick={() => setStopAsked(true)} disabled={pending}><Square />{t('dashboard.stop')}</Button>
              : <Button size="sm" data-target="open" onClick={() => run(onStart)} disabled={installingNow} loading={pending}><Play />{t('dashboard.start')}</Button>}
          </> : null;

  return <>
    <Card className="runtime-card" data-tour="installation">
      <CardHeader className="runtime-head">
        <h2 className="panel-title">
          SillyTavern
          <StatePill tone={tone}>{stateWord}</StatePill>
        </h2>
        {/* The actions sit in the card's corner with room to spare, and under
            the picture on a phone, where the corner is the title's line and
            the picture is what the thumb reaches for next. Drawn in both
            places and shown in one; see `.runtime-actions-*`. */}
        <CardAction className="runtime-actions runtime-actions-head">{runtimeActions}</CardAction>
      </CardHeader>

      <CardContent className="runtime-body">
        {/*
          * The picture is of something that is running. With SillyTavern down
          * there is nothing to show a picture of, and a still of a front page
          * that is not being served reads as an invitation to click something
          * that does nothing - so the box goes empty and says why.
          */}
        <div className="runtime-preview" data-live={running ? 'true' : 'false'}>
          {running ? <SillyTavernStill generation={process.startedAt ?? 'up'} /> : null}
          {/* From another device the frame cannot be shown, so the same
              invitation opens SillyTavern in a tab at the best address instead
              of explaining why it will not. */}
          {canEmbed
            ? <button type="button" className="runtime-preview-open" onClick={() => void openEmbed()}>
              <span className="runtime-preview-cta"><Monitor aria-hidden="true" />{embedOpening ? t('common.loading') : embedMounted ? t('console.embedResume') : t('console.useItHere')}</span>
              <span className="runtime-preview-note">{embedMounted ? t('console.embedResumeHint') : t('console.useItHereHint')}</span>
            </button>
            : waitingForLink
              ? <button type="button" className="runtime-preview-open" onClick={() => void publish()} disabled={publishing || tunnel.mode !== 'off'}>
                <span className="runtime-preview-cta"><Globe2 aria-hidden="true" />{publishing || tunnel.mode !== 'off' ? t('console.linkStarting') : t('console.getLink')}</span>
                <span className="runtime-preview-note">{t('console.getLinkHint')}</span>
              </button>
              : running
              ? <button type="button" className="runtime-preview-open" onClick={openPrimary}>
                <span className="runtime-preview-cta"><ArrowUpRight aria-hidden="true" />{t('console.useItHere')}</span>
                <span className="runtime-preview-note">{t('console.useItInTabHint')}</span>
              </button>
              : <div className="runtime-preview-idle">
                <Monitor aria-hidden="true" />
                <span>{t('console.stateOffline')}</span>
              </div>}
        </div>
        {runtimeActions ? <div className="runtime-actions runtime-actions-below">{runtimeActions}</div> : null}

        <dl className="runtime-meta">
          {/* Nothing is answering at any of these while SillyTavern is down,
              so the row goes rather than standing there with a dash in it. */}
          {running ? <div className="runtime-row">
            <dt>{t('console.addressLabel')}</dt>
            <dd>
              {primary
                ? <AddressLink t={t} href={primary.url}>
                  <span className="address-full">{primary.host}</span>
                  <span className="address-short">{shortenHost(primary.host)}</span>
                </AddressLink>
                : <span className="text-muted-foreground">{t('console.noAddressYet')}</span>}
              {otherCount > 0
                ? <button type="button" className="runtime-shared" onClick={onShowAddresses}>{t('console.alsoOnline', { count: otherCount })}</button>
                : null}
            </dd>
          </div> : null}

          <div className="runtime-row">
            <dt><label htmlFor="install-version">{t('dashboard.version')}</label></dt>
            <dd className="runtime-version">
              <Select value={version} onValueChange={onVersionChange}>
                <SelectTrigger id="install-version" size="sm" className="runtime-select"><SelectValue /></SelectTrigger>
                <SelectContent position="popper" align="start" className="version-select-content">
                  {choices.map((choice) => <SelectItem key={choice.selector} value={choice.selector}>{choice.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {alreadyInstalled
                ? <Tooltip><TooltipTrigger asChild><span className="inline-flex"><Button variant="outline" size="sm" disabled><Download />{t('console.versionInstalled')}</Button></span></TooltipTrigger><TooltipContent>{t('console.versionInstalledHint')}</TooltipContent></Tooltip>
                : <Button variant="success" size="sm" data-target="install" onClick={requestInstall} disabled={!csrfToken} loading={installing || recovering !== null}><Download />{t('dashboard.install')}</Button>}
            </dd>
          </div>

          <div className="runtime-row">
            <dt>{t('console.dataProfile')}</dt>
            <dd>
              <span>{profileName ?? t('console.noProfiles')}</span>
              {profileName === null ? null : <span className="runtime-sep" aria-hidden="true">·</span>}
              {profileName === null ? null : dataBytes === null ? <span className="thinking">{t('system.measuring')}</span> : <span className="runtime-bytes">{formatBytes(dataBytes)}</span>}
            </dd>
          </div>

          {/* Before the install job exists there is still work, and saying so
              is what makes the greyed-out button above mean something rather
              than look broken. */}
          {!installingNow && recovering !== null ? <div className="runtime-row">
            <dt>{t('console.progressLabel')}</dt>
            <dd className="runtime-progress">
              <TaskLine task={jobLabel(t, recovering.kind)} step={translateStep(recovering.step, catalog, recovering.stepCode, recovering.stepParams)} percent={recovering.progress} />
              <TaskBar percent={recovering.progress} />
            </dd>
          </div> : null}

          {installingNow && active ? <div className="runtime-row">
            <dt>{t('console.progressLabel')}</dt>
            <dd className="runtime-progress">
              <TaskLine task={t('console.taskInstall')} step={translateStep(active.step, catalog, active.stepCode, active.stepParams)} percent={active.progress} />
              <TaskBar percent={active.progress} />
              {/* A first install is minutes of Git and npm, and on a phone a
                  good deal more. Somebody who started it by mistake, or on the
                  wrong version, used to have nothing to press. What is stopped
                  is taken back by the server, so the machine is left as it was
                  found rather than holding half a checkout. */}
              {canCancelInstall ? <div className="runtime-progress-actions">
                {/* Red, like every other stop in the console. An outline button
                    beside a progress bar read as a second, milder choice; it is
                    not - it ends the work the bar is measuring. */}
                <Button variant="destructive" size="sm" loading={stoppingInstall} onClick={() => stopInstall()}>
                  <Square />{stoppingInstall ? t('console.installStopping') : t('console.installStop')}
                </Button>
              </div> : null}
            </dd>
          </div> : removing ? <div className="runtime-row">
            <dt>{t('console.progressLabel')}</dt>
            <dd className="runtime-progress">
              <TaskLine task={t('console.taskUninstall')} step={process.status === 'stopping' && waitingFor ? waitingFor : t('console.uninstallRemoving')} />
              <TaskBar />
            </dd>
          </div> : waitingFor ? <div className="runtime-row">
            <dt>{t('console.progressLabel')}</dt>
            <dd className="runtime-progress">
              <TaskLine task={waitingTask} step={waitingFor} />
              <TaskBar />
            </dd>
          </div> : null}

          {failure ? <div className="runtime-row">
            <dt>{t('console.problemLabel')}</dt>
            <dd><span className="install-error" role="alert">{failure}</span></dd>
          </div> : null}
        </dl>
      </CardContent>

      {showUpdate && update ? <div className="runtime-update" role="status">
        <CircleArrowUp aria-hidden="true" />
        <span>{t('console.updateAvailable', { version: update.label })}</span>
        <div className="runtime-update-actions">
          <Button variant="success" size="sm" onClick={takeUpdate}><Download />{t('console.updateNow')}</Button>
          <Button variant="ghost" size="sm" onClick={dismissUpdate}>{t('console.updateDismiss')}</Button>
        </div>
      </div> : null}

      {installed ? <CardFooter className="runtime-foot">
        <div className="runtime-foot-actions">
          <Button variant="ghost" size="sm" onClick={onOpenSettings}><Settings2 />{t('nav.config')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setAskedRemove(true)} disabled={installing || removing}><Trash2 />{t('console.uninstall')}</Button>
        </div>
      </CardFooter> : null}
    </Card>

    {/* Mounted on nothing but whether it was opened. It used to go with the
        best address too, so a tunnel reconnecting - or a fixed address being
        redeployed - took the window down for the seconds there was no public
        address, and brought it back as a fresh frame with the chat reloaded.
        The frame loads the door on this machine, which those seconds do not
        touch; only the "open in a tab" link needs an address, and the door's
        own is the right thing to fall back to. */}
    {embedMounted ? <EmbedStage t={t} fail={fail} catalog={catalog} csrfToken={csrfToken} open={embedOpen} url={embedUrl} openUrl={primary?.url ?? embedUrl} onMinimize={() => setEmbedOpen(false)} onClose={() => { setEmbedOpen(false); setEmbedMounted(false); }} /> : null}

    <ConfirmDialog
      open={stopAsked}
      onOpenChange={setStopAsked}
      title={t('console.stopConfirm')}
      description={t('console.stopConfirmBody')}
      confirmLabel={t('dashboard.stop')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => run(onStop)}
    />
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
    <PasscodeDialog
      t={t}
      open={passcodeAsked}
      onOpenChange={setPasscodeAsked}
      note={null}
      onSubmit={async (passcode, confirmPasscode) => {
        const failure = await onSetPassword(passcode, confirmPasscode);
        if (failure) return failure;
        // The PIN was only ever the condition. What was asked for goes on
        // with the dialog already gone.
        // A tab cannot be opened from here - the press that asked for it is
        // long gone - so the tools window waits for the next one.
        if (afterPasscode === 'tools') return null;
        setPublishing(true);
        void onPublish().finally(() => setPublishing(false));
        return null;
      }}
    />
    <ConfirmDialog
      open={askedStopInstall}
      onOpenChange={setAskedStopInstall}
      title={t('console.installStopConfirm')}
      description={t('console.installStopConfirmBody')}
      confirmLabel={t('console.installStop')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => { setStoppingInstall(true); try { await onCancelInstall(); } finally { setStoppingInstall(false); } }}
    />
    <ConfirmDialog
      open={askedRemove}
      onOpenChange={setAskedRemove}
      title={t('console.uninstallConfirm')}
      description={t('console.uninstallConfirmBody')}
      confirmLabel={t('console.uninstall')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => { setRemoving(true); try { report(await onRemove()); } finally { setRemoving(false); } }}
    />
  </>;
}

function AccessPanel({ t, process, tunnel, config, security, sillyTavernPort, onAction, onSetLan, onSetPassword }: { t: Translate; process: ProcessState; tunnel: TunnelState; config: ConfigDocument | null; security: AccessGatewayState; sillyTavernPort: number; onAction: (path: string, body?: unknown) => Promise<void>; onSetLan: (lan: boolean) => Promise<string | null>; onSetPassword: (password: string, confirmPassword: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const running = process.status === 'running';
  const { toast } = useToast();
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
  // The address to show, which is null both before cloudflared has announced
  // one and while the fixed address in front of it is still being deployed.
  const publicUrl = publicAddress(tunnel);
  // The door is the manager's own, so its password and its reach are known
  // whether or not SillyTavern happens to be up. Nothing here has to wait for
  // a version to answer, and no reading is ever "unknown".
  const passwordReady = security.passwordConfigured;
  const lan = security.lan;
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Turning either of these off takes an address away from whoever is on the
  // other end of it, and they are not in the room to be asked.
  const [closing, setClosing] = useState<'tunnel' | 'lan' | null>(null);
  const runAction = async (path: string, body?: unknown) => { setBusy(true); try { await onAction(path, body); } finally { setBusy(false); } };
  const setTunnel = async (on: boolean) => { await runAction('/api/v1/tunnel', { mode: on ? 'quick' : 'off' }); };
  /*
   * What to turn on once a PIN exists, or null when nothing is waiting.
   *
   * A switch pressed without a PIN is a request, not a state: it opens the
   * dialog that asks for one, and it is that dialog finishing which turns the
   * thing on. Until then the switch shows what is true, which is off - and a
   * dialog closed without a PIN leaves it there, because nothing was turned on.
   * These switches used to be disabled instead, with a line underneath naming a
   * prerequisite, which left the reader to go and find the prerequisite
   * themselves.
   */
  const [waiting, setWaiting] = useState<'tunnel' | 'lan' | null>(null);
  const askForPassword = (what: 'tunnel' | 'lan') => { setWaiting(what); setPasswordOpen(true); };
  const toggleTunnel = (next: boolean) => {
    if (!next) { setClosing('tunnel'); return; }
    if (!passwordReady) { askForPassword('tunnel'); return; }
    void setTunnel(true);
  };
  const setLanTo = async (next: boolean) => {
    setSecurityBusy(true);
    try {
      // A refusal is a result: said once, then gone. Whether the gateway is
      // currently broken is state, and stays on the card below.
      const failure = await onSetLan(next);
      if (failure) toast({ title: failure, tone: 'destructive' });
      else toast({ title: next ? t('console.lanOnDone') : t('console.lanOffDone'), tone: 'success' });
    } finally { setSecurityBusy(false); }
  };
  const toggleLan = (next: boolean) => {
    if (!next) { setClosing('lan'); return; }
    if (!passwordReady) { askForPassword('lan'); return; }
    void setLanTo(true);
  };
  // This machine reaches SillyTavern directly, because the loopback address is
  // already a boundary. Everything else goes through the gateway and its
  // password: the LAN address and the tunnel both point there.
  const local = localHost(sillyTavernPort);
  // Whether the reader is on the machine this is running on. From anywhere else
  // - another device on the Wi-Fi, a hosted studio, a forwarded port - the
  // loopback address names the reader's own computer, so it is shown as what it
  // is rather than offered as a link into a machine it was never going to reach.
  const onThisMachine = isThisMachine(window.location.hostname);
  /*
   * Null where this machine has no address on a network around it, which is
   * the whole of a hosted container: there is no Wi-Fi for another device to
   * share. It fell back to the address in the reader's browser, which on a
   * hosted studio is the platform's own hostname - offered here as "on this
   * Wi-Fi" though the platform serves no such port, and the phone being
   * invited is on a different network altogether.
   *
   * Read off the gateway state rather than the configuration document, which
   * carries the same address: that document arrives only once SillyTavern is
   * installed, and this switch is on screen from the first visit.
   */
  const lanHost = security.networkHost ? `${security.networkHost}:${security.port}` : null;
  const localUrl = `http://${local}`;
  const lanUrl = lanHost ? `http://${lanHost}` : null;
  /*
   * What this card reports is whether the doors are answering, which is not
   * the same question as whether either switch is on.
   *
   * Turning SillyTavern off does not turn the sharing off - nobody asked for
   * that, and a switch that flips itself back is a switch nobody can trust -
   * but it does leave the addresses with nothing behind them. Saying "online"
   * then would be untrue and saying "off" would be a lie about the switches,
   * so the third state says the actual situation: the doors are open and
   * waiting for something to be behind them.
   */
  const shared = tunnelWanted || lan;
  const accessTone: StatusTone = tunnel.error ? 'attention' : running && shared ? 'online' : shared ? 'attention' : 'offline';
  const accessLabel = tunnel.error ? t('dashboard.offline')
    : running && shared ? t('console.online')
      : shared ? t('console.waitingForSillyShort')
        : t('dashboard.offline');
  return <Card data-tour="remote-access">
    <PanelHeading icon={<Globe2 />} action={<StatePill tone={accessTone}>{accessLabel}</StatePill>}>{t('console.publicAccess')}</PanelHeading>
    <CardContent className="flex-1">
      {/*
        * Two questions, asked in that order: what is open, and where does it
        * answer. The switches used to sit between the addresses, each one
        * followed by the address it turned on, so the reader met the whole
        * card twice over to find the one line they came for.
        *
        * The tunnel is first because it is the one that reaches a phone that
        * is not in the house.
        */}
      {/*
        * Each switch says, in one short line, what it does for the person
        * reading it.
        *
        * It used to say what it needed instead - "Cloudflare tunnel · Password
        * required before sharing" - which told somebody who did not already
        * know what a tunnel is two things they could not use: a brand they had
        * not heard of, and a prerequisite. The feature most worth trying was
        * the one most often never tried.
        *
        * Nothing here mentions the passcode any more, in either state. The
        * switch asks for one the moment it is pressed, which is the moment it
        * means anything; announcing it beforehand spends the only line these
        * rows have on a condition rather than on a reason.
        */}
      <div className="access-switches">
        <div className="access-row">
          <div>
            <strong>{t('console.quickTunnel')}{!tunnelWanted ? <span className="access-badge"><Star />{t('console.tunnelBadge')}</span> : null}</strong>
            <span>{t('console.tunnelWhy')}</span>
          </div>
          {/* Not waiting on SillyTavern. The tunnel publishes the door in
              front of it, which is up from the moment the console is, and it
              serves SillyTavern the moment SillyTavern answers - so somebody
              setting a machine up gets to do these steps in whichever order
              suits them, and the address is ready before it is needed. */}
          <Switch id="tunnel-switch" data-target="tunnel" checked={tunnelWanted} onCheckedChange={toggleTunnel} disabled={busy} aria-label={t('console.enableTunnel')} />
        </div>
        {/* Offered only where it can work. With no address of its own on a
            network, this switch opens a door onto nothing: it cannot be
            turned on, and the line says why rather than inviting a phone
            onto a Wi-Fi this machine is not on. Already on - a setting
            restored from a machine that did have a network - it stays
            switchable, because turning something off is never the press
            that needs protecting from. */}
        <div className="access-row">
          <div>
            <strong>{t('console.lanAccess')}</strong>
            <span>{lanHost ? t('console.lanWhy') : t('console.lanNoNetwork')}</span>
          </div>
          <Switch id="listen-switch" checked={lan} onCheckedChange={toggleLan} disabled={securityBusy || (!lan && lanHost === null)} aria-label={t('console.enableLan')} />
        </div>
      </div>
      {/* With SillyTavern down every one of these leads nowhere, so the whole
          group goes rather than three rows of dashes. */}
      {running ? <>
        <div className="access-group-label">{t('console.addresses')}</div>
        <div className="address-rows">
          {/* The fixed Worker address when there is one, because that is the
              address worth giving anybody; the tunnel's own is inside the
              sheet, where somebody looking for it will find it. */}
          <AddressRow
            t={t}
            label={t('dashboard.publicAddress')}
            url={publicUrl}
            display={publicUrl ?? ''}
            disabledHint={tunnelWanted ? t('console.addressComing') : t('console.tunnelOffShort')}
            pending={tunnelWanted}
            {...(publicUrl && tunnel.proxyUrl && tunnel.url ? { alternates: [tunnel.url] } : {})}
          />
          {lanHost ? <AddressRow t={t} label={t('console.lanAddress')} url={lan ? lanUrl : null} display={lanHost} disabledHint={t('console.lanOffShort')} /> : null}
          <AddressRow t={t} label={t('console.local')} url={onThisMachine ? localUrl : null} display={local} disabledHint={t('console.localElsewhere')} />
        </div>
      </> : null}
      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(open) => { if (!open) setClosing(null); }}
        title={closing === 'lan' ? t('console.lanOffConfirm') : t('console.tunnelOffConfirm')}
        description={closing === 'lan' ? t('console.lanOffConfirmBody') : t('console.tunnelOffConfirmBody')}
        confirmLabel={t('common.turnOff')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => { if (closing === 'lan') await setLanTo(false); else await setTunnel(false); }}
      />
      <PasscodeDialog
        t={t}
        open={passwordOpen}
        onOpenChange={(open) => { setPasswordOpen(open); if (!open) setWaiting(null); }}
        note={null}
        onSubmit={async (passcode, confirmPasscode) => {
          const failure = await onSetPassword(passcode, confirmPasscode);
          if (failure) return failure;
          const next = waiting;
          setWaiting(null);
          if (next === 'tunnel') void setTunnel(true);
          if (next === 'lan') void setLanTo(true);
          return null;
        }}
      />
      {busy || securityBusy ? <div className="operation-progress" role="status"><span className="thinking">{t('common.loading')}</span><TaskBar /></div> : null}
      {security.error ? <p className="install-error" role="alert">{security.error}</p> : null}
      {tunnel.error ? <p className="install-error" role="alert">{tunnel.error}</p> : null}
    </CardContent>
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
          <Button onClick={() => save()} disabled={busy || !ready}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Set the passcode, twice.
 *
 * Twice because a passcode that was mistyped once locks the door on its owner
 * from wherever they were going to use it, and there is no "forgot it" here -
 * only the console on the machine itself.
 *
 * The two entries used to be the same screen with a different sentence under
 * the title, and people typed the confirmation believing they were still
 * choosing. They are two steps now, and look it: a step marker at the top, a
 * title and a mark of their own, and the second entry fills in green.
 *
 * The dialog goes the moment the second entry matches. Saving the PIN, and
 * whatever it was the condition for - a link, the network - carries on
 * behind it; a failure comes back as a notification rather than as a dialog
 * that sat there spinning.
 */
function PasscodeDialog({ t, open, onOpenChange, note, onSubmit }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; note: string | null; onSubmit: (passcode: string, confirmPasscode: string) => Promise<string | null> }) {
  const [entered, setEntered] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const [stage, setStage] = useState<'enter' | 'confirm'>('enter');
  const [mismatch, setMismatch] = useState(false);
  const { toast } = useToast();
  const labels = { digit: t('console.passcodeDigit'), clear: t('console.passcodeClear'), backspace: t('console.passcodeBackspace') };

  const reset = () => { setEntered(''); setConfirmed(''); setStage('enter'); setMismatch(false); };
  // Cleared on the way in rather than the way out, so the dialog does not
  // flick back to the first step while it fades.
  useEffect(() => { if (open) reset(); }, [open]);
  const close = (next: boolean) => { onOpenChange(next); };

  const finish = (code: string) => {
    const passcode = entered;
    close(false);
    void (async () => {
      try {
        const failure = await onSubmit(passcode, code);
        // Success is announced by whoever saved it; only a failure is news here.
        if (failure) toast({ title: failure, tone: 'destructive' });
      } catch {
        toast({ title: t('console.passwordSaveFailed'), tone: 'destructive' });
      }
    })();
  };

  const confirming = stage === 'confirm';
  const steps = [
    { id: 'enter', label: t('console.passcodeStepCreate') },
    { id: 'confirm', label: t('console.passcodeStepConfirm') },
  ] as const;

  return <Dialog open={open} onOpenChange={close}>
    {/* A dialog focuses its first field as it opens. On a touch screen that
        field is the one under the dots, and focus there is what used to bring
        the device's keypad up over the one drawn below it. */}
    {/* No corner X: Cancel is at the bottom, and the X kept the header's
        right edge free for itself, which put the centred title off centre. */}
    <DialogContent className="sm:max-w-sm" showCloseButton={false} onOpenAutoFocus={(event) => { if (!window.matchMedia('(pointer: fine)').matches) event.preventDefault(); }}>
      <DialogHeader className="items-center pr-5 text-center sm:text-center">
        <ol className="passcode-steps mb-2" aria-label={t('console.passwordSettings')}>
          {steps.map((step, index) => {
            const state = step.id === stage ? 'current' : index === 0 && confirming ? 'done' : 'todo';
            return <li key={step.id} className="passcode-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="passcode-step-mark" aria-hidden="true">{state === 'done' ? <Check /> : index + 1}</span>
              <span>{step.label}</span>
            </li>;
          })}
        </ol>
        <span className="passcode-badge" data-stage={stage} aria-hidden="true">{confirming ? <ShieldCheck /> : <KeyRound />}</span>
        <DialogTitle>{confirming ? t('console.passcodeConfirmTitle') : t('console.passcodeCreateTitle')}</DialogTitle>
        <DialogDescription>{confirming ? t('console.passcodeRepeat') : t('console.passcodeChoose')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        {/* Keyed on the step, so each one arrives rather than being the last
            one with its dots emptied. */}
        <div key={stage} className="animate-in fade-in slide-in-from-right-4 duration-200 motion-reduce:animate-none">
          {confirming
            ? <PasscodeInput
              value={confirmed}
              tone="success"
              onChange={(value) => { setConfirmed(value); if (value.length > 0) setMismatch(false); }}
              onComplete={(value) => { if (value === entered) finish(value); else { setMismatch(true); setConfirmed(''); } }}
              label={t('console.confirmPassword')}
              length={PASSCODE_DIGITS}
              labels={labels}
              autoFocus
            />
            : <PasscodeInput
              value={entered}
              onChange={setEntered}
              onComplete={() => setStage('confirm')}
              label={t('console.passwordSettings')}
              length={PASSCODE_DIGITS}
              labels={labels}
              autoFocus
            />}
        </div>
        {mismatch ? <Alert variant="destructive"><AlertDescription>{t('console.passcodeMismatch')}</AlertDescription></Alert> : null}
        {note ? <p className="text-center text-xs text-muted-foreground">{note}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => close(false)}>{t('common.cancel')}</Button>
        {confirming
          ? <Button variant="outline" onClick={reset}><RotateCcw />{t('console.passcodeAgain')}</Button>
          : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** An address that opens in its own tab rather than sitting there as text. */
function AddressLink({ t, href, children }: { t: Translate; href: string; children: ReactNode }) {
  return <a className="address-link" href={href} target="_blank" rel="noopener noreferrer" title={t('console.openInNewTab')}><code>{children}</code></a>;
}

/**
 * One address, and the one button that does everything else with it.
 *
 * The card used to carry an Open button and a Copy button in its footer, both
 * of which acted on whichever address the card had decided was the important
 * one, plus a Show QR toggle that pushed the rest of the card down when it was
 * pressed. Each address now answers for itself: the address is the link, and
 * the button beside it opens the sheet that holds the code, the copy and the
 * open - for that address, not for whichever one the footer had in mind.
 */
function AddressRow({ t, label, url, display, disabledHint, pending, alternates }: { t: Translate; label: string; url: string | null; display: string; disabledHint?: string; pending?: boolean; alternates?: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return <div className="address-row">
    <span className="address-name">{label}</span>
    <span className="address-value">
      {/* An address on its way is the same wait the manager's own link shows
          on the settings page, so it is shown the same way: the words sweep
          while something is happening behind them. Standing text here read as
          a state that had settled, next to a switch that was already on. */}
      {url ? <AddressLink t={t} href={url}>{display}</AddressLink> : <code className={pending ? 'address-absent thinking' : 'address-absent'}>{disabledHint ?? '—'}</code>}
    </span>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`${t('console.shareAddress')} · ${label}`}
      title={t('console.shareAddress')}
      disabled={url === null}
      onClick={() => setOpen(true)}
    ><QrCodeIcon /></Button>
    {url ? <ShareDialog t={t} open={open} onOpenChange={setOpen} label={label} links={[url, ...(alternates ?? [])]} /> : null}
  </div>;
}

/**
 * The code, and every address that reaches this door.
 *
 * Three things and no fourth: the code, and one line per address, each of them
 * a link. Where a place has two addresses - a Worker with a fixed name and the
 * tunnel it forwards to - both are here, one under the other, because either
 * works and a reader is entitled to see the second rather than be told about
 * it. The first is the one the code carries and the one worth sharing.
 */
function ShareDialog({ t, open, onOpenChange, label, links, description }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; label: string; links: readonly string[]; /** What scanning it opens, when it is not SillyTavern. */ description?: string }) {
  const primary = links[0] ?? '';
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="share-dialog">
      <DialogHeader>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>{description ?? t('console.scanToOpen')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="share-body">
        <QrCode value={primary} label={`${label}: ${primary}`} />
        <div className="share-links">
          {links.map((link) => <a key={link} className="share-url" href={link} target="_blank" rel="noopener noreferrer">{link}</a>)}
        </div>
      </DialogBody>
    </DialogContent>
  </Dialog>;
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
function DataPanel({ t, navigate, latestBackup, snapshot, onRemeasure }: { t: Translate; navigate: Navigate; latestBackup: BackupManifest | null; snapshot: SystemSnapshot | null; onRemeasure: () => Promise<void> }) {
  /*
   * Two figures, because they answer two different questions.
   *
   * One number for the whole installation invited the reading that the
   * manager's own footprint and SillyTavern's data were separate things being
   * added up, when the second is inside the first. Split, each half says what
   * it is: what can be deleted to get room back, and what is actually being
   * chatted with.
   *
   * The archive half is the remainder rather than a measurement of its own, so
   * with more than one profile it also carries the profiles that are not
   * running. That is the honest place to put them - they are stored, not in
   * use - and it keeps the two halves adding up to the total on disk.
   */
  const storage = snapshot?.storage ?? null;
  const dataBytes = storage?.dataBytes ?? null;
  const totalBytes = storage?.managerBytes ?? null;
  // Measured, as opposed to still being walked. A machine with no profile has
  // no `dataBytes`, which is an answer rather than an absence of one: the size
  // is what the manager holds, and none of it is a profile yet.
  const measured = totalBytes !== null;
  const profileBytes = dataBytes ?? 0;
  const otherBytes = totalBytes === null ? 0 : Math.max(0, totalBytes - profileBytes);
  return <Card data-tour="data" className="overview-pair">
    <PanelHeading icon={<Database />}>{t('console.dataAndBackups')}</PanelHeading>
    <CardContent className="flex-1">
      <div className="grid gap-1">
        <DetailRow label={t('console.sizeLabel')}>
          {measured
            ? <span className="size-split">
              <span>{formatBytes(otherBytes)} <em>({t('console.sizeBackups')})</em></span>
              <span aria-hidden="true">+</span>
              <span>{formatBytes(profileBytes)} <em>({t('console.sizeData')})</em></span>
            </span>
            : <span className="thinking">{t('system.measuring')}</span>}
        </DetailRow>
        {latestBackup
          ? <DetailRow label={t('status.lastBackup')}>{new Date(latestBackup.createdAt).toLocaleString()}</DetailRow>
          : <DetailRow label={t('status.lastBackup')}>
            <Button variant="outline" size="sm" onClick={() => navigate('data')}><DatabaseBackup />{t('dashboard.backupNow')}</Button>
          </DetailRow>}
      </div>
      {storage ? <p className="system-note">
        {storage.measuredAt ? <span>{t('system.sizesMeasuredAt')} {new Date(storage.measuredAt).toLocaleTimeString()}</span> : <span />}
        <Button variant="ghost" size="sm" onClick={() => onRemeasure()} disabled={storage.measuring}><RefreshCw />{storage.measuring ? t('system.measuring') : t('system.remeasure')}</Button>
      </p> : null}
    </CardContent>
    <CardFooter><Button variant="outline" className="w-full" onClick={() => navigate('data')}><Database />{t('console.manageData')}<ArrowUpRight /></Button></CardFooter>
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
  const [searchOpen, setSearchOpen] = useState(contentProps.query.length > 0);
  // While the sheet is open the card keeps its footprint but not its content,
  // so the page behind does not reflow and the log is not rendered twice.
  const cardContents = expanded ? <div className="log-card-placeholder" aria-hidden="true" /> : <LogsContent {...contentProps} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} />;
  return <Card data-tour="logs" data-expanded={expanded}><PanelHeading icon={<ScrollText />} action={<LogControls {...contentProps} searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((value) => !value)}>
    <Button variant="ghost" size="sm" onClick={onToggleExpanded} aria-label={t('console.expandLogs')} title={t('console.expandLogs')}><Maximize2 /><span className="log-control-label">{t('console.expandLogs')}</span></Button>
  </LogControls>}>{t('console.liveLogs')}</PanelHeading>{cardContents}</Card>;
}

/**
 * The expanded log, mounted for every page rather than only the overview, so
 * the header button can reach it from wherever the operator happens to be.
 */
function LogsSheet({ open, onClose, ...contentProps }: LogViewProps & { open: boolean; onClose: () => void }) {
  const { t } = contentProps;
  const [searchOpen, setSearchOpen] = useState(contentProps.query.length > 0);
  return <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <SheetContent side="bottom" className="log-sheet" showCloseButton={false}>
      <SheetHeader className="log-sheet-header"><SheetTitle>{t('console.liveLogs')}</SheetTitle><LogControls {...contentProps} searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((value) => !value)}>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('console.collapseLogs')} title={t('console.collapseLogs')}><Minimize2 /><span className="log-control-label">{t('console.collapseLogs')}</span></Button>
      </LogControls></SheetHeader>
      <LogsContent {...contentProps} expanded searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} />
    </SheetContent>
  </Sheet>;
}

/** Distance from the bottom, in pixels, still treated as "following the tail". */
const LOG_FOLLOW_SLACK = 48;
/** Distance from the top that asks for the previous page of retained lines. */
const LOG_BACKFILL_SLACK = 120;

/** Where log lines come from, in the order the filter offers them. */
function logSources(t: Translate): ReadonlyArray<{ readonly id: LogSourceFilter; readonly label: string }> {
  return [
    { id: 'all', label: t('console.allLogs') },
    { id: 'sillytavern', label: 'SillyTavern' },
    { id: 'manager', label: 'Manager' },
    { id: 'cloudflared', label: 'Cloudflare Tunnel' },
    { id: 'installer', label: t('console.installer') },
    { id: 'backup', label: t('nav.backups') },
  ];
}

/**
 * The log's controls, as a row of small buttons in its header.
 *
 * They used to be a full-width source dropdown, an always-open search field
 * and a labelled density button - three rows on a phone before the first
 * line of log. Now search is a magnifier that opens its field when wanted,
 * the source is a funnel with a menu, and on a phone the words go and the
 * icons stay.
 */
function LogControls({ t, source, onSourceChange, compact, onToggleCompact, query, searchOpen, onToggleSearch, children }: Pick<LogViewProps, 't' | 'source' | 'onSourceChange' | 'compact' | 'onToggleCompact' | 'query'> & { searchOpen: boolean; onToggleSearch: () => void; children?: ReactNode }) {
  const sources = logSources(t);
  const current = sources.find((entry) => entry.id === source) ?? sources[0];
  return <div className="log-controls">
    <Button variant={searchOpen || query ? 'secondary' : 'ghost'} size="sm" onClick={onToggleSearch} aria-pressed={searchOpen} aria-label={t('console.searchLogs')} title={t('console.searchLogs')}><Search /><span className="log-control-label">{t('console.searchLogsShort')}</span></Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={source === 'all' ? 'ghost' : 'secondary'} size="sm" aria-label={`${t('console.logSource')}: ${current?.label ?? ''}`} title={t('console.logSource')}><Funnel /><span className="log-control-label">{current?.label}</span></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('console.logSource')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={source} onValueChange={(value) => onSourceChange(value as LogSourceFilter)}>
          {sources.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}>{entry.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <Button variant="ghost" size="sm" onClick={onToggleCompact} aria-pressed={compact} aria-label={compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')} title={compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}><Rows3 /><span className="log-control-label">{compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}</span></Button>
    {children}
  </div>;
}

function LogsContent({ t, catalog, source, entries, query, onQueryChange, compact, onLoadOlder, hasOlder, loadingOlder, expanded = false, searchOpen, onCloseSearch }: LogViewProps & { expanded?: boolean; searchOpen: boolean; onCloseSearch: () => void }) {
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  // Prepending history moves everything down; remember where the top was so the
  // reader keeps looking at the same line instead of being thrown forward.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const normalizedQuery = foldForSearch(query.trim());
  // Searched in the words on screen as well as the English the server wrote,
  // so a line reads the same to the search as it does to the reader, in
  // either language.
  const visibleEntries = normalizedQuery.length === 0 ? entries : entries.filter((entry) => foldForSearch(`${entry.source} ${entry.message} ${translateLogEntry(entry, catalog)}`).includes(normalizedQuery));
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
    {searchOpen || query ? <div className="log-search">
      <Search aria-hidden="true" />
      <Input autoFocus className="focus-visible:border-input focus-visible:ring-0" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { onQueryChange(''); onCloseSearch(); } }} placeholder={t('console.searchLogs')} aria-label={t('console.searchLogs')} />
      <Button variant="ghost" size="icon-sm" className="log-search-clear" onClick={() => { onQueryChange(''); onCloseSearch(); }} aria-label={t('common.close')}><X /></Button>
    </div> : null}
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

const BACKUP_KIND_LABEL = {
  manual: 'console.backupKindManual',
  scheduled: 'console.backupKindScheduled',
  'before-restore': 'console.backupKindBeforeRestore',
  'before-switch': 'console.backupKindBeforeSwitch',
  r2: 'console.backupKindR2',
  uploaded: 'console.backupKindUploaded',
} as const satisfies Record<BackupKind, string>;

/**
 * Why a backup exists, as a small coloured label.
 *
 * The one someone took on purpose is the accent, the safety copies are amber
 * because they are what to reach for after a restore went wrong, and the ones
 * that happen on their own stay quiet.
 */
function BackupKindBadge({ t, kind }: { t: Translate; kind: BackupKind }) {
  return <span className="backup-kind" data-kind={kind}>{t(BACKUP_KIND_LABEL[kind])}</span>;
}

/** A name the manager chose itself, including the suffix-style names older versions chose. */
function isManagerName(backup: BackupManifest): boolean {
  if (backup.autoNamed) return true;
  if (backup.kind) return false;
  return /-(scheduled|prerestore|preswitch)\.zip$|-r2-[^.]+\.zip$|-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/u.test(backup.name);
}

/**
 * What a backup is called on screen.
 *
 * A name somebody typed is theirs and is shown as typed. A name the manager
 * made up is only ever a kind and a time, so it is said as that - in the
 * reader's language and date format, "Tự động · 16/09/2026 16:35" - and
 * changes with the language. The file keeps its plain ASCII name, which is
 * what a download is saved as.
 */
export function backupDisplayName(t: Translate, locale: string, backup: BackupManifest): string {
  if (!isManagerName(backup)) return backup.name;
  const when = new Date(backup.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  return `${t(BACKUP_KIND_LABEL[backupKind(backup)])} · ${when}`;
}

/**
 * A moment as `hh:mm dd/mm/yyyy`, for a column that has to fit on a phone.
 *
 * Not `toLocaleString`: that writes the reader's long form, which on a narrow
 * table wraps onto two or three lines and pushes the size and the button out of
 * the row. Digits in a fixed order are the same width in every language and
 * are read the same way in both of the ones this console speaks.
 */
export function shortWhen(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())} ${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}`;
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

interface R2KeysForm {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface R2ScheduleForm {
  readonly hotIntervalMinutes: number;
  readonly coldIntervalHours: number;
  readonly keepRecent: number;
  readonly keepDaily: number;
  readonly keepWeekly: number;
}

function r2KeysFrom(config: R2Config | null): R2KeysForm {
  return {
    endpoint: config?.endpoint ?? '',
    bucket: config?.bucket ?? '',
    accessKeyId: config?.accessKeyIdMasked ? SECRET_MASK : '',
    secretAccessKey: config?.secretAccessKeyConfigured ? SECRET_MASK : '',
  };
}

function r2ScheduleFrom(config: R2Config | null): R2ScheduleForm {
  return {
    hotIntervalMinutes: config?.schedule.hotIntervalMinutes ?? 5,
    coldIntervalHours: config?.schedule.coldIntervalHours ?? 6,
    keepRecent: config?.retention.keepRecent ?? 24,
    keepDaily: config?.retention.keepDaily ?? 30,
    keepWeekly: config?.retention.keepWeekly ?? 0,
  };
}

/*
 * The R2 schedule, asked as two plain questions.
 *
 * The dialog used to ask for six numbers, three of them retention: "keep
 * recovery points", "then keep one a day", "then keep one a week". Each was
 * accurate and together they were a puzzle - nobody could say how far back
 * 48, 14 and 8 let them go without working it out. The question people have
 * is how far back, so that is what is asked, and each answer is a set of the
 * same numbers the server has always taken. The numbers are still there, under
 * "Exact numbers", and a combination that matches no answer reads as Custom.
 */
const CUSTOM_CHOICE = 'custom';
const R2_UPLOAD_CHOICES = [
  { id: '5m', label: 'console.every5Minutes', hotIntervalMinutes: 5, coldIntervalHours: 6 },
  { id: '15m', label: 'console.every15Minutes', hotIntervalMinutes: 15, coldIntervalHours: 12 },
  { id: '1h', label: 'console.everyHour', hotIntervalMinutes: 60, coldIntervalHours: 24 },
] as const;
const R2_HISTORY_CHOICES = [
  { id: '7d', label: 'console.r2Back7Days', keepRecent: 24, keepDaily: 7, keepWeekly: 0 },
  { id: '30d', label: 'console.r2Back30Days', keepRecent: 24, keepDaily: 30, keepWeekly: 0 },
  { id: '3m', label: 'console.r2Back3Months', keepRecent: 24, keepDaily: 14, keepWeekly: 13 },
  { id: '1y', label: 'console.r2Back1Year', keepRecent: 24, keepDaily: 14, keepWeekly: 52 },
] as const;
/** How often the backup library takes a local copy. Not an R2 setting. Off is `0`, set by the switch. */
const DEFAULT_LOCAL_INTERVAL = 30;
const LOCAL_BACKUP_CHOICES = [
  { id: '30m', label: 'console.every30Minutes', intervalMinutes: 30 },
  { id: '1h', label: 'console.everyHour', intervalMinutes: 60 },
  { id: '6h', label: 'console.every6Hours', intervalMinutes: 360 },
  { id: '1d', label: 'console.everyDay', intervalMinutes: 1440 },
] as const;
function uploadChoice(hotIntervalMinutes: number, coldIntervalHours: number) {
  return R2_UPLOAD_CHOICES.find((choice) => choice.hotIntervalMinutes === hotIntervalMinutes && choice.coldIntervalHours === coldIntervalHours);
}

function historyChoice(keepRecent: number, keepDaily: number, keepWeekly: number) {
  return R2_HISTORY_CHOICES.find((choice) => choice.keepRecent === keepRecent && choice.keepDaily === keepDaily && choice.keepWeekly === keepWeekly);
}

/** The schedule in one line, for the card: "Every 5 minutes · 30 days back". */
function r2ScheduleSummary(t: Translate, config: R2Config): string {
  const upload = uploadChoice(config.schedule.hotIntervalMinutes, config.schedule.coldIntervalHours);
  const history = historyChoice(config.retention.keepRecent, config.retention.keepDaily, config.retention.keepWeekly);
  return `${upload ? t(upload.label) : t('console.r2Custom')} · ${history ? t('console.r2BackFor', { period: t(history.label) }) : t('console.r2Custom')}`;
}

/**
 * What to call a job that this page did not start.
 *
 * The name a button carries when it starts the work, so a page returning to
 * work already running says the same thing it would have said all along.
 */
function jobLabel(t: Translate, kind: Job['kind']): string {
  if (kind === 'restore') return t('console.restore');
  if (kind === 'r2Upload') return t('console.r2UploadLatest');
  if (kind === 'r2Fetch') return t('console.r2Fetch');
  return t('dashboard.backupNow');
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
/** The dropdown's last line, which opens the form instead of switching. */
const NEW_PROFILE = '__new_profile__';

function DataPage({ t, locale, fail, catalog, csrfToken, profiles, activeProfileId, backups, onProfilesChange, onBackupsChange, intent, onIntentHandled }: { t: Translate; locale: string; fail: Fail; catalog: Record<string, unknown>; csrfToken: string; profiles: Profile[]; activeProfileId: string | null; backups: BackupManifest[]; onProfilesChange: (profiles: Profile[], activeProfileId: string | null) => void; onBackupsChange: (backups: BackupManifest[]) => void; /** Something the overview's checklist sent the reader here to do. */ intent: 'connect' | null; onIntentHandled: () => void }) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /*
   * The one thing on this page that is state rather than a result.
   *
   * A restore stopped halfway leaves the profile part old and part new. That
   * is true until somebody does something about it, so it stays on the page;
   * everything else here happened once and is said once, in a toast.
   */
  const [mixedProfile, setMixedProfile] = useState<string | null>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('replace');
  const [selectedBackup, setSelectedBackup] = useState<BackupManifest | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<RestorePreview | null>(null);
  /** The reader has been shown that this archive is not a profile and said to go ahead. */
  const [restoreAnyway, setRestoreAnyway] = useState(false);
  // Leave out what SillyTavern can do without; asked in saver mode, and
  // required when the restore does not fit otherwise.
  const [restoreTrim, setRestoreTrim] = useState(false);
  const [operationProgress, setOperationProgress] = useState<{ percent: number; step: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  // What the Stop button acts on: a server job by id, or the upload in flight.
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const [r2Config, setR2Config] = useState<R2Config | null>(null);
  /**
   * Whether this machine keeps what is written to it.
   *
   * Null until the first answer arrives, and the notice below waits for it:
   * a warning that appears and then takes itself back is worse than one that
   * arrives a moment late.
   */
  const [storage, setStorage] = useState<StorageDurabilityReport | null>(null);
  const [backupSchedule, setBackupSchedule] = useState<LocalBackupSchedule | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  // Saver mode takes no local archives, so the buttons that would write one
  // are put away and the card says why.
  const [saving, setSaving] = useState(false);
  // The recovery point whose in-place restore is being asked about.
  const [restorePoint, setRestorePoint] = useState<R2SnapshotSummary | null>(null);
  // A zip still in the browser whose directory the server has read, waiting on
  // the restore question; see `streamUpload`.
  const [streaming, setStreaming] = useState<{ readonly file: File; readonly uploadId: string } | null>(null);
  const [r2Snapshots, setR2Snapshots] = useState<R2SnapshotSummary[]>([]);
  const [r2Busy, setR2Busy] = useState<string | null>(null);
  const [settingsOffer, setSettingsOffer] = useState<ManagerSettingsOffer | null>(null);
  const [dismissedRecovery, setDismissedRecovery] = useState<string | null>(() => readDismissedRecovery(browserStorage()));
  const [profileOpen, setProfileOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BackupManifest | null>(null);
  const [kindFilter, setKindFilter] = useState<BackupKind | 'all'>('all');
  // Which archive is being deleted, and whether the question is on screen. The
  // two are separate because the dialog fades out: clearing the row at the same
  // moment left the title reading "Delete ?" for the length of the animation.
  const [deleteTarget, setDeleteTarget] = useState<BackupManifest | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /*
   * Where the data goes and how often are two questions, so they are two forms.
   *
   * "Where" is one form for both ways of answering it. A sign-in and a key pair
   * are two answers to one question, and as two rows on the card - each with
   * its own hint, its own button and its own state - they read as two things
   * that both needed doing. One dialog, one choice, and the card keeps a single
   * line saying which answer is in force.
   */
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [r2ScheduleOpen, setR2ScheduleOpen] = useState(false);
  /*
   * The Cloudflare sign-in address, when this page could not open it itself.
   *
   * Kept on the page rather than announced and taken away again. It used to be
   * a toast: the one case where the reader has to do something with a link is
   * the one case where the link must not vanish while they look for somewhere
   * to put it.
   */
  const [cloudflareSignInUrl, setCloudflareSignInUrl] = useState<string | null>(null);
  const [r2Toggling, setR2Toggling] = useState(false);
  const [cloudflareBusy, setCloudflareBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  // What the last look at the bucket found. Kept on the card, because an answer
  // that disappears two seconds after it arrives is not an answer.
  const [r2Check, setR2Check] = useState<R2CheckResult | null>(null);
  // The usage panel owns its own fetch; this lets one press of Check bring it
  // up to date too, instead of a second button that only refreshes.
  const usageRefresh = useRef<(() => void) | null>(null);
  // Newest first: the archive somebody wants is nearly always the last one taken.
  const [backupQuery, setBackupQuery] = useState<TableQuery>(() => initialQuery({ sort: 'createdAt', direction: 'desc' }));
  const [snapshotQuery, setSnapshotQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 5, sort: 'createdAt', direction: 'desc' }));
  const busy = busyAction !== null;
  const labels = tableLabels(t);
  const { toast } = useToast();
  const done = (title: string) => toast({ title, tone: 'success' });
  const failed = (title: string) => toast({ title, tone: 'destructive' });
  const jobStep = (job: Job) => translateStep(job.step, catalog, job.stepCode, job.stepParams);
  const refresh = async () => {
    const [profileResponse, backupResponse, r2Response, snapshotResponse, scheduleResponse, saverResponse] = await Promise.all([apiFetch('/api/v1/profiles', { credentials: 'same-origin' }), apiFetch('/api/v1/backups', { credentials: 'same-origin' }), apiFetch('/api/v1/r2', { credentials: 'same-origin' }), apiFetch('/api/v1/r2/snapshots', { credentials: 'same-origin' }).catch(() => null), apiFetch('/api/v1/backups/schedule', { credentials: 'same-origin' }).catch(() => null), apiFetch('/api/v1/saver', { credentials: 'same-origin' }).catch(() => null)]);
    // Listing recovery points needs the bucket, so it is the one call here that
    // fails when R2 is off or unreachable. That must not blank the page.
    if (snapshotResponse?.ok) {
      const payload = await snapshotResponse.json() as { snapshots: R2SnapshotSummary[] };
      setR2Snapshots(payload.snapshots);
    } else setR2Snapshots([]);
    if (profileResponse.ok) { const payload = await profileResponse.json() as { profiles: Profile[]; activeProfileId: string | null }; onProfilesChange(payload.profiles, payload.activeProfileId); }
    if (backupResponse.ok) { const payload = await backupResponse.json() as { backups: BackupManifest[] }; onBackupsChange(payload.backups); }
    if (r2Response.ok) {
      const payload = await r2Response.json() as { config: R2Config; storage?: StorageDurabilityReport };
      setR2Config(payload.config);
      if (payload.storage) setStorage(payload.storage);
    }
    if (scheduleResponse?.ok) setBackupSchedule((await scheduleResponse.json() as { schedule: LocalBackupSchedule }).schedule);
    if (saverResponse?.ok) setSaving((await saverResponse.json() as { saver: SaverState }).saver.enabled);
  };
  useEffect(() => { void refresh(); }, []);
  // Opened once the settings are in, so the form opens on the right answer.
  useEffect(() => {
    if (intent !== 'connect' || r2Config === null) return;
    setDestinationOpen(true);
    onIntentHandled();
  }, [intent, r2Config === null]);

  /*
   * Coming back from Cloudflare, by either of the two ways back.
   *
   * The server finishes the sign-in before the browser gets here and says how
   * it went. Where this page sent itself, that arrives in its own address;
   * where it could not - a console inside another site's page, which has to
   * open a window because Cloudflare refuses to be framed - it arrives as a
   * message from that window. Both end up here.
   */
  // Stopped when this page goes away, so a console left on another tab is not
  // still asking about a sign-in nobody is waiting for.
  const collecting = useRef<(() => void) | null>(null);
  useEffect(() => () => collecting.current?.(), []);
  const settleCloudflare = (outcome: string, code: string) => {
    if (outcome === 'connected') {
      void apiFetch('/api/v1/r2', { credentials: 'same-origin' })
        .then(async (response) => (response.ok ? (await response.json() as { config: R2Config }).config : null))
        .then((config) => {
          toast({ title: t('console.cfConnected', { bucket: config?.cloudflare?.bucket ?? '' }), tone: 'success', duration: 8000 });
          if (config) setR2Config(config);
          // Reading the bucket is how anyone finds out whether the connection
          // they just made actually works, and it was left as a button to
          // press. Asked here instead, so what the reader comes back to is the
          // answer rather than another thing to do.
          void checkAfterConnect(config);
        })
        .catch(() => undefined);
    } else if (outcome === 'choose_account') {
      // The sign-in worked and the only thing left is a choice, so the form
      // that holds that choice opens rather than being described in a message
      // the reader then has to go and act on.
      toast({ title: t('console.cfChooseNow'), tone: 'success', duration: 8000 });
      setDestinationOpen(true);
    } else {
      failed(cloudflareErrorText(t, code));
    }
  };

  // Said once, then taken out of the address so a reload does not say it again.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('cloudflare');
    if (!outcome) return;
    const code = params.get('cloudflare_error') ?? '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    settleCloudflare(outcome, code);
  }, []);

  /*
   * The R2 card follows the scheduler the same way the list does.
   *
   * Reading the settings is local and free on the machine, and still a request
   * against the console's Worker allowance when the console is reached at its
   * fixed address - so it is asked on the slow clock. What it is watching for
   * is an upload, and uploads happen every five minutes at their fastest:
   * asking every ten seconds was oversampling a five-minute event thirty
   * times over. Listing recovery points is a charged request to the bucket, so
   * it is made only when the last upload time says there is a new one to list.
   */
  const lastUploadSeen = useRef<string | null | undefined>(undefined);
  usePoll(async () => {
    try {
      const response = await apiFetch('/api/v1/r2', { credentials: 'same-origin' });
      if (!response.ok) return;
      const config = (await response.json() as { config: R2Config }).config;
      setR2Config(config);
      const previous = lastUploadSeen.current;
      lastUploadSeen.current = config.lastUploadAt;
      if (previous !== undefined && previous !== config.lastUploadAt && config.configured) {
        const snapshots = await apiFetch('/api/v1/r2/snapshots', { credentials: 'same-origin' });
        if (snapshots.ok) setR2Snapshots((await snapshots.json() as { snapshots: R2SnapshotSummary[] }).snapshots);
      }
    } catch {
      // The next poll tries again.
    }
  }, { intervalMs: POLL_BACKGROUND_MS });

  /*
   * Whether this account holds settings from another machine.
   *
   * Asked once, when a connection first works, and not on a clock: reading it
   * is a charged request to the bucket, and the answer only changes when
   * somebody sets a different machine up.
   */
  const connectedToR2 = r2Config?.configured === true && r2Config.enabled;
  useEffect(() => {
    if (!connectedToR2) { setSettingsOffer(null); return undefined; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/r2/settings', { credentials: 'same-origin' });
        if (!response.ok || cancelled) return;
        setSettingsOffer((await response.json() as { settings: ManagerSettingsOffer }).settings);
      } catch {
        // Nothing is offered, which is the same as there being nothing to offer.
      }
    })();
    return () => { cancelled = true; };
  }, [connectedToR2]);

  /*
   * A job already in flight, picked up by a page that did not start it.
   *
   * A restore runs in the server for minutes, and this page is left and come
   * back to - another tab, a reload - while it does. Showing an idle screen
   * then invites starting the same work a second time.
   *
   * What it is showing is taken from the job's kind, so it comes back where it
   * was started and under the name it was started with. Kind used to say only
   * "backup", so a recovery point coming down from R2 reappeared as "Back up
   * now" in the local backup card, with a download's progress under it.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let kind: Job['kind'] | null = null;
      const setBusy = (label: string | null) => { if (kind && isCloudJob(kind)) setR2Busy(label); else setBusyAction(label); };
      try {
        const response = await apiFetch('/api/v1/jobs/active', { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json() as { job: Job | null };
        if (cancelled || !payload.job) return;
        const running = payload.job;
        kind = running.kind;
        setBusy(jobLabel(t, kind));
        setOperationProgress({ percent: running.progress, step: jobStep(running) });
        setRunningJobId(running.id);
        const finished = await waitForOperation(running.id, (job) => { if (!cancelled) setOperationProgress({ percent: job.progress, step: jobStep(job) }); });
        if (cancelled) return;
        await refresh();
        // A fetch that finishes while this page is watching ends where it ends
        // when this page started it: at the question of what to do with what
        // came down, rather than at a row in a list to go and find.
        if (kind === 'r2Fetch') {
          const landed = finished.resultBackupId ? await readBackup(finished.resultBackupId) : null;
          if (!cancelled && landed && await openRestoreFor(landed)) return;
        }
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof StoppedError) done(t(kind === 'restore' ? 'console.restoreStopped' : 'console.backupStopped'));
        else if (error instanceof RollbackFailedError) setMixedProfile(t(saving ? 'console.restoreStoppedPartwaySaver' : 'console.restoreStoppedPartway'));
        else failed(error instanceof Error ? error.message : t(kind === 'r2Fetch' ? 'console.r2FetchFailed' : kind === 'r2Upload' ? 'console.r2UploadFailed' : 'console.backupRestoreFailed'));
      } finally {
        if (!cancelled) { setBusy(null); setOperationProgress(null); setRunningJobId(null); }
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
    if (stopping) return;
    // "Stopping" from the press until the work has actually ended, not only
    // for as long as the request takes: a restore putting the data back runs
    // on for minutes, and a button that came back pressable in that time
    // invited pressing it again and again.
    setStopping(true);
    try {
      uploadAbort.current?.abort();
      if (runningJobId) {
        const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(runningJobId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
        // Refused because it had already finished is not worth a second press either.
        if (!response.ok && response.status !== 409) setStopping(false);
      }
    } catch {
      setStopping(false);
    }
  };
  useEffect(() => { if (busyAction === null && r2Busy === null) setStopping(false); }, [busyAction, r2Busy]);

  // Chunks are held in the browser until the last one lands, so a reload or a
  // navigation away throws the whole upload out. Warn before that happens.
  useEffect(() => {
    if (!uploading) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  const createProfile = async (name: string): Promise<string | null> => {
    setBusyAction(t('console.newProfile'));
    try {
      const response = await apiFetch('/api/v1/profiles', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name, layout: 'data' }) });
      if (!response.ok) return fail.body(await response.json(), t('console.profileCreateFailed'));
      await refresh();
      return null;
    } catch { return t('console.profileCreateFailed'); } finally { setBusyAction(null); }
  };
  const activate = async (id: string) => {
    setBusyAction(t('console.switchProfile'));
    try {
      const response = await apiFetch(`/api/v1/profiles/${id}/activate`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { failed(fail.body(await response.json(), t('console.profileActivateFailed'))); return; }
      await refresh();
    } catch { failed(t('console.profileActivateFailed')); } finally { setBusyAction(null); }
  };
  /**
   * Start a backup and follow it on the page.
   *
   * "Back up now" is the automatic backup taken early - no name, no dialog,
   * and it replaces the previous automatic one. "Manual backup" asks for a
   * name and is kept. Either way the answer returns as soon as the server has
   * accepted the job, so the dialog closes at once and the progress is shown
   * where the Stop button is.
   */
  const startBackup = async (kind: 'scheduled' | 'manual', name = '', note = ''): Promise<string | null> => {
    const label = kind === 'scheduled' ? t('dashboard.backupNow') : t('console.manualBackup');
    setBusyAction(label); setOperationProgress(null);
    let jobId: string;
    try {
      const response = await apiFetch('/api/v1/backups', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ kind, ...(name ? { name } : {}), ...(note ? { note } : {}) }) });
      const payload = await response.json() as { jobId?: string; unchanged?: boolean; error?: { message?: string } };
      if (response.ok && payload.unchanged) { setBusyAction(null); toast({ title: t('console.backupUpToDate'), tone: 'default' }); return null; }
      if (!response.ok || !payload.jobId) { setBusyAction(null); return fail.body(payload, t('console.backupCreateFailed')); }
      jobId = payload.jobId;
    } catch { setBusyAction(null); return t('console.backupCreateFailed'); }
    setRunningJobId(jobId);
    void (async () => {
      try {
        await waitForOperation(jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
        await refresh();
        done(t('console.backupDone'));
      } catch (error: unknown) {
        // Stopping is an answer rather than a failure; the list says what is there.
        if (error instanceof StoppedError) { await refresh(); done(t('console.backupStopped')); }
        else failed(error instanceof Error ? error.message : t('console.backupCreateFailed'));
      } finally { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
    })();
    return null;
  };
  const waitForOperation = async (jobId: string, onUpdate: (job: Job) => void): Promise<Job> => {
    for (;;) {
      const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(t('console.backupRestoreFailed'));
      const job = await response.json() as Job;
      onUpdate(job);
      if (job.state === 'succeeded') return job;
      if (job.state === 'canceled') throw new StoppedError();
      if (job.state === 'failed' && job.stepCode === 'job.rollbackFailed') throw new RollbackFailedError(job.error ?? t('console.backupRestoreFailed'));
      if (job.state === 'failed') throw new Error(job.error ?? t('console.backupRestoreFailed'));
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 700));
    }
  };
  const previewBackup = async (backup: BackupManifest) => {
    setBusyAction(t('console.restore'));
    try {
      await openRestoreFor(backup);
    } finally { setBusyAction(null); }
  };
  /**
   * Look inside an archive and ask what to do with it.
   *
   * Shared by the Restore menu item and by whatever has just put an archive in
   * the library - an uploaded zip, a recovery point brought back from R2 - so
   * all three end at the same question instead of one of them ending at a
   * notification and a list to go hunting through.
   */
  /** One archive by id, asked for straight rather than found again in the list. */
  const readBackup = async (backupId: string): Promise<BackupManifest | null> => {
    try {
      const response = await apiFetch(`/api/v1/backups/${encodeURIComponent(backupId)}`, { credentials: 'same-origin' });
      return response.ok ? await response.json() as BackupManifest : null;
    } catch { return null; }
  };
  const openRestoreFor = async (backup: BackupManifest): Promise<boolean> => {
    try {
      const response = await apiFetch(`/api/v1/backups/${backup.id}/preview`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as RestorePreview | { error?: { message?: string } };
      if (!response.ok || !('files' in payload)) { failed(fail.body(payload, t('console.backupPreviewFailed'))); return false; }
      setRestoreMode('replace');
      // Said once, for this archive. An archive that has to be insisted on is
      // asked about again the next time it is opened.
      setRestoreAnyway(false); setRestoreTrim(false);
      setSelectedBackup(backup); setSelectedPreview(payload);
      return true;
    } catch { failed(t('console.backupPreviewFailed')); return false; }
  };
  const closeRestore = () => {
    // A zip nobody went on to restore is nothing to the server but its
    // directory in memory; say so rather than leave it to time out.
    if (streaming) void apiFetch(`/api/v1/backups/stream?uploadId=${encodeURIComponent(streaming.uploadId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
    setStreaming(null); setRestorePoint(null); setSelectedBackup(null); setSelectedPreview(null); setRestoreAnyway(false); setRestoreTrim(false);
  };
  /**
   * Saver mode's upload: look inside the zip without sending it.
   *
   * The directory at the end of the file is all the server needs to check the
   * archive and say what it holds, so that is all that goes before the
   * question. The rest goes after, straight into the profile; see
   * `restoreStreamed`.
   */
  const streamUpload = async (file: File) => {
    setBusyAction(t('console.importZip')); setOperationProgress(null);
    try {
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - ZIP_TAIL_SEARCH_BYTES)).arrayBuffer());
      const offset = centralDirectoryOffset(tail, file.size);
      if (offset === null) { failed(t('errors.invalid_archive')); return; }
      const response = await apiFetch('/api/v1/backups/stream', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-archive-size': String(file.size), 'x-csrf-token': csrfToken }, body: file.slice(offset) });
      const payload = await response.json() as (RestorePreview & { uploadId?: string }) | { error?: { message?: string } };
      if (!response.ok || !('uploadId' in payload) || !payload.uploadId) { failed(fail.body(payload, t('console.backupPreviewFailed'))); return; }
      setRestoreMode('replace');
      setStreaming({ file, uploadId: payload.uploadId });
      setSelectedPreview(payload);
    } catch (error: unknown) {
      failed(error instanceof Error ? error.message : t('console.backupPreviewFailed'));
    } finally { setBusyAction(null); }
  };
  /**
   * Send the zip, and let the server write it into the profile as it arrives.
   *
   * The server stops SillyTavern and puts the current data in R2 before it is
   * ready, which can take minutes; until then a chunk is answered "not yet"
   * and sent again, and the bar shows what the server is doing instead. Any
   * way the upload ends early - a failure, Stop, the network - ends the job
   * too, and the job is what says what became of the profile.
   */
  const restoreStreamed = async () => {
    if (!streaming) return;
    const { file, uploadId } = streaming;
    const force = restoreAnyway;
    const trim = restoreTrim;
    setStreaming(null); setSelectedPreview(null); setRestoreAnyway(false); setRestoreTrim(false);
    setBusyAction(t('console.restore')); setOperationProgress(null); setMixedProfile(null); setUploading(true);
    const controller = new AbortController();
    uploadAbort.current = controller;
    let jobId: string | null = null;
    try {
      const response = await apiFetch('/api/v1/backups/stream/restore', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ uploadId, mode: restoreMode, ...(force ? { force: true } : {}), ...(trim ? { trim: true } : {}) }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.backupRestoreFailed'))); return; }
      jobId = payload.jobId;
      setRunningJobId(jobId);
      let uploadError: unknown = null;
      try {
        const samples: Array<{ at: number; bytes: number }> = [{ at: Date.now(), bytes: 0 }];
        for (let index = 0, offset = 0; offset < file.size;) {
          const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
          const answer = await uploadChunkWithRetry(
            `/api/v1/backups/stream/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`,
            file.slice(offset, end),
            { 'content-type': 'application/octet-stream', 'x-csrf-token': csrfToken, accept: 'application/json' },
            { fail, failed: t('console.uploadFailed'), proxyPage: t('console.uploadProxyPage') },
            controller.signal,
          ) as { ready?: boolean; done?: boolean } | null;
          if (!answer?.ready) {
            // Still getting ready: what it is doing is the job's to say.
            const jobResponse = await apiFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
            const job = jobResponse.ok ? await jobResponse.json() as Job : null;
            if (job) setOperationProgress({ percent: job.progress, step: jobStep(job) });
            if (job && job.state !== 'running' && job.state !== 'queued') break;
            samples.splice(0, samples.length, { at: Date.now(), bytes: offset });
            continue;
          }
          index += 1; offset = end;
          const at = Date.now();
          samples.push({ at, bytes: end });
          while (samples.length > 2 && at - (samples[0]?.at ?? at) > UPLOAD_RATE_WINDOW_MS) samples.shift();
          const oldest = samples[0] ?? { at, bytes: 0 };
          const elapsedMs = at - oldest.at;
          const bytesPerSecond = elapsedMs > 0 ? ((end - oldest.bytes) / elapsedMs) * 1000 : 0;
          const remaining = bytesPerSecond > 0 ? `${formatDuration((file.size - end) / bytesPerSecond)} ${t('console.uploadRemaining')}` : t('console.uploadEstimating');
          setOperationProgress({ percent: Math.round((end / Math.max(file.size, 1)) * 100), step: `${t('console.restoringUpload')} ${formatBytes(end)} / ${formatBytes(file.size)} · ${formatBytes(Math.round(bytesPerSecond))}/s · ${remaining}` });
          if (answer.done) break;
        }
      } catch (error: unknown) {
        uploadError = error;
        // The upload is over; so is the restore waiting on it.
        await apiFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
      }
      setUploading(false);
      await waitForOperation(jobId, (job) => { if (uploadError === null) setOperationProgress({ percent: job.progress, step: jobStep(job) }); });
      if (uploadError) throw uploadError;
      await refresh();
      done(t('console.restoreDone'));
    } catch (error: unknown) {
      if (error instanceof StoppedError) { done(t('console.restoreStopped')); await refresh(); }
      else if (error instanceof RollbackFailedError) { setMixedProfile(t('console.restoreStoppedPartwaySaver')); await refresh(); }
      else failed(error instanceof Error ? error.message : t('console.backupRestoreFailed'));
      if (!jobId) void apiFetch(`/api/v1/backups/stream?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
    } finally { uploadAbort.current = null; setBusyAction(null); setOperationProgress(null); setRunningJobId(null); setUploading(false); }
  };
  const restoreSelected = async () => {
    if (streaming) { await restoreStreamed(); return; }
    if (restorePoint) {
      const point = restorePoint;
      const choice = { mode: restoreMode, force: restoreAnyway, trim: restoreTrim };
      closeRestore();
      await restorePointInPlace(point, choice);
      return;
    }
    if (!selectedBackup || !selectedPreview) return;
    const backupId = selectedBackup.id;
    const trim = restoreTrim;
    // The question has been answered, so the dialog goes before the work
    // starts: what happens next belongs on the page, where the Stop button is.
    closeRestore();
    setBusyAction(t('console.restore')); setOperationProgress(null); setMixedProfile(null);
    try {
      const response = await apiFetch(`/api/v1/backups/${backupId}/restore`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: restoreMode, ...(restoreAnyway ? { force: true } : {}), ...(trim ? { trim: true } : {}) }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.backupRestoreFailed'))); return; }
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh();
      done(t('console.restoreDone'));
    } catch (error: unknown) {
      // A stopped restore is put back by the server before it reports, so a
      // stop is a result to glance at. Only a stop that could not be put back
      // leaves the profile mixed, and that stays on the page.
      if (error instanceof StoppedError) { done(t('console.restoreStopped')); await refresh(); }
      else if (error instanceof RollbackFailedError) { setMixedProfile(t(saving ? 'console.restoreStoppedPartwaySaver' : 'console.restoreStoppedPartway')); await refresh(); }
      else failed(error instanceof Error ? error.message : t('console.backupRestoreFailed'));
    } finally { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
  };
  const inspectUpload = async (file: File | undefined) => {
    if (!file) return;
    if (saving) { await streamUpload(file); return; }
    setBusyAction(t('console.importZip')); setOperationProgress(null); setUploading(true);
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
          { fail, failed: t('console.uploadFailed'), proxyPage: t('console.uploadProxyPage') },
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
      catch { throw new Error(apiErrorFromText(text, response.status, t('console.backupPreviewFailed'), fail, t('console.uploadProxyPage'))); }
      if (!response.ok || !('files' in payload)) { failed(fail.body(payload, t('console.backupPreviewFailed'))); return; }
      if (!payload.backup) { failed(t('console.backupPreviewFailed')); return; }
      setRestoreMode('replace');
      setSelectedBackup(payload.backup); setSelectedPreview(payload);
      await refresh();
    } catch (error: unknown) {
      // The part file on the server is worth nothing without the rest of it,
      // whether the upload failed or the operator stopped it.
      await apiFetch(`/api/v1/backups/import/chunk?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
      if (!(error instanceof StoppedError)) failed(error instanceof Error ? error.message : t('console.backupPreviewFailed'));
    } finally { uploadAbort.current = null; setBusyAction(null); setOperationProgress(null); setUploading(false); }
  };
  const renameBackup = async (name: string): Promise<string | null> => {
    if (!renameTarget) return null;
    setBusyAction(t('common.rename'));
    try {
      const response = await apiFetch(`/api/v1/backups/${renameTarget.id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name }) });
      if (!response.ok) return fail.body(await response.json(), t('console.backupRenameFailed'));
      await refresh();
      return null;
    } catch { return t('console.backupRenameFailed'); } finally { setBusyAction(null); }
  };
  const deleteBackup = async () => {
    if (!deleteTarget) return;
    const backup = deleteTarget;
    setBusyAction(t('common.delete'));
    try {
      const response = await apiFetch(`/api/v1/backups/${backup.id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { failed(fail.body(await response.json(), t('console.backupDeleteFailed'))); return; }
      if (selectedBackup?.id === backup.id) closeRestore();
      await refresh();
    } catch { failed(t('console.backupDeleteFailed')); } finally { setBusyAction(null); setDeleteOpen(false); }
  };
  const putR2 = async (body: Record<string, unknown>): Promise<string | null> => {
    try {
      const response = await apiFetch('/api/v1/r2', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) return fail.body(payload, t('console.r2SaveFailed'));
      setR2Config(payload.config);
      done(t('console.r2Saved'));
      void refresh().catch(() => undefined);
      return null;
    } catch { return t('console.r2SaveFailed'); }
  };
  /**
   * Saving keys is choosing them over the Cloudflare sign-in.
   *
   * The two ways of reaching a bucket are never both in use, and this form is
   * the one that says "use the keys" - which is why the switch is asked for
   * before the form opens, not silently applied after it.
   */
  const saveR2Keys = async (form: R2KeysForm & { readonly enabled?: boolean }): Promise<string | null> => await putR2({ ...form, mode: 'keys' });
  const saveR2Schedule = async (form: R2ScheduleForm): Promise<string | null> => await putR2({ ...form });
  // The switch lives on the card, not at the bottom of the settings dialog:
  // whether anything is being sent at all is the first thing to see, and
  // turning it off should not mean opening the connection settings to do it.
  // Turning the schedule off stores 0, which forgets the interval; turning it
  // back on brings back the one last seen here, or the default.
  const lastInterval = useRef(DEFAULT_LOCAL_INTERVAL);
  useEffect(() => { if (backupSchedule && backupSchedule.intervalMinutes > 0) lastInterval.current = backupSchedule.intervalMinutes; }, [backupSchedule]);
  const saveBackupSchedule = async (intervalMinutes: number) => {
    setScheduleSaving(true);
    try {
      const response = await apiFetch('/api/v1/backups/schedule', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ intervalMinutes }) });
      const payload = await response.json() as { schedule?: LocalBackupSchedule; error?: { message?: string } };
      if (!response.ok || !payload.schedule) { failed(fail.body(payload, t('console.localScheduleFailed'))); return; }
      setBackupSchedule(payload.schedule);
      done(t('console.localScheduleSaved'));
    } catch { failed(t('console.localScheduleFailed')); } finally { setScheduleSaving(false); }
  };
  const setR2Enabled = async (enabled: boolean) => {
    setR2Toggling(true);
    try {
      const response = await apiFetch('/api/v1/r2', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ enabled }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) { failed(fail.body(payload, t('console.r2SaveFailed'))); return; }
      setR2Config(payload.config);
      done(t(enabled ? 'console.r2TurnedOn' : 'console.r2TurnedOff'));
    } catch { failed(t('console.r2SaveFailed')); } finally { setR2Toggling(false); }
  };
  const connectCloudflare = async () => {
    setCloudflareSignInUrl(null);
    /*
     * Cloudflare's sign-in refuses to load in a frame. When the panel is shown
     * inside another page, the sign-in gets a tab of its own, opened now while
     * the click still counts as one so it is not taken for a pop-up.
     *
     * Unless this browser has already said no once, in which case it is not
     * asked again: the answer belongs to the frame rather than to the press.
     * The button below becomes a plain link instead, and a press on a link is
     * the one thing that is never blocked.
     */
    const inFrame = framed();
    const tab = inFrame && !popupsBlocked() ? openReturnWindow() : null;
    setCloudflareBusy(true);
    try {
      // Inside a frame the answer is collected from the manager however the
      // sign-in was opened, because the tab cannot bring it back itself; see
      // oauth.ts.
      const response = await apiFetch(`/api/v1/r2/cloudflare/connect${inFrame ? '?handoff=1' : ''}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { url?: string; handoff?: string; error?: { message?: string } };
      if (!response.ok || !payload.url) { tab?.close(); failed(fail.body(payload, t('console.cfConnectFailed'))); return; }
      if (!inFrame) { window.location.assign(payload.url); return; }
      if (payload.handoff) {
        const stopCollecting = collectCloudflareResult(payload.handoff, (result) => settleCloudflare(result.outcome, result.code));
        const stopWatching = tab ? whenAbandoned(tab, stopCollecting) : null;
        collecting.current = () => { stopCollecting(); stopWatching?.(); };
      }
      if (tab) { tab.location.href = payload.url; return; }
      // No tab, so the reader opens one. The sign-in is already started and
      // already being collected; the address goes on the button they pressed.
      setCloudflareSignInUrl(payload.url);
    } catch { tab?.close(); failed(t('console.cfConnectFailed')); } finally { setCloudflareBusy(false); }
  };
  /*
   * Ask again whether the account has R2 now.
   *
   * Turning R2 on happens in Cloudflare's dashboard, in another tab, and
   * nothing tells this page when it is done. So it is asked when the reader
   * says so, and quietly whenever they come back to this tab - which is
   * what somebody who has just finished over there does next.
   */
  const recheckR2 = async (quiet = false) => {
    const outcome = await recheckR2Activation(csrfToken);
    if (outcome.state === 'enabled') {
      setR2Config(outcome.config);
      done(t('console.cfConnected', { bucket: outcome.config.cloudflare?.bucket ?? '' }));
      await refresh();
      await checkAfterConnect(outcome.config);
    } else if (!quiet) {
      failed(outcome.state === 'still_off' ? t('console.cfR2StillOff') : fail.body(outcome.payload, t('console.cfConnectFailed')));
    }
  };
  const chooseCloudflareAccount = async (accountId: string): Promise<string | null> => {
    if (!accountId) return null;
    setCloudflareBusy(true);
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/account', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ accountId }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      // An account that has never turned R2 on fails here with everything else
      // in order. The refusal is on the connection now, so the card says it
      // and keeps saying it; this only has to not swallow it.
      if (!response.ok || !payload.config) { const message = fail.body(payload, t('console.cfConnectFailed')); failed(message); await refresh(); return message; }
      setR2Config(payload.config);
      done(t('console.cfConnected', { bucket: payload.config.cloudflare?.bucket ?? '' }));
      await refresh();
      await checkAfterConnect(payload.config);
      return null;
    } catch { failed(t('console.cfConnectFailed')); return t('console.cfConnectFailed'); } finally { setCloudflareBusy(false); }
  };
  /** Back up to another bucket of the account already signed in to. */
  const chooseCloudflareBucket = async (name: string): Promise<string | null> => {
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/bucket', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) return fail.body(payload, t('console.cfBucketFailed'));
      setR2Config(payload.config);
      done(t('console.cfBucketSaved', { bucket: payload.config.cloudflare?.bucket ?? name }));
      void refresh().catch(() => undefined);
      return null;
    } catch { return t('console.cfBucketFailed'); }
  };
  const disconnectCloudflare = async () => {
    setCloudflareBusy(true);
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/disconnect', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { revoked?: boolean; config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) { failed(fail.body(payload, t('console.cfDisconnectFailed'))); return; }
      setR2Config(payload.config);
      if (payload.revoked) done(t('console.cfDisconnected'));
      else toast({ title: t('console.cfDisconnectedNotRevoked'), tone: 'destructive', duration: 12000 });
      await refresh();
    } catch { failed(t('console.cfDisconnectFailed')); } finally { setCloudflareBusy(false); }
  };
  const backUpToCloudflare = async () => {
    setCloudflareBusy(true);
    try {
      const response = await apiFetch('/api/v1/r2', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: 'cloudflare', enabled: true }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) { failed(fail.body(payload, t('console.r2SaveFailed'))); return; }
      setR2Config(payload.config);
      done(t('console.cfConnected', { bucket: payload.config.cloudflare?.bucket ?? '' }));
      await refresh();
      await checkAfterConnect(payload.config);
    } catch { failed(t('console.r2SaveFailed')); } finally { setCloudflareBusy(false); }
  };
  /**
   * The one question about the bucket, asked once.
   *
   * There used to be three buttons here - Test connection, Check the bucket,
   * Refresh - that between them proved the credentials, brought the counts back
   * in line and re-read Cloudflare's figures. Each was a separate press with a
   * separate name, two of them read as the same thing, and all three answered
   * with a notification that said it had worked and then went away. They are
   * one press now, and the answer stays on the card.
   */
  const checkR2 = async () => {
    setR2Busy(t('console.r2Checking'));
    try {
      const response = await apiFetch('/api/v1/r2/check', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { check?: R2CheckResult; config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.check) { failed(fail.body(payload, t('console.r2TestFailed'))); return; }
      setR2Check(payload.check);
      if (payload.config) setR2Config(payload.config);
      // What Cloudflare itself reports is the other half of the same question,
      // so one press asks for both rather than leaving a Refresh behind.
      usageRefresh.current?.();
      await refresh();
    } catch { failed(t('console.r2TestFailed')); } finally { setR2Busy(null); }
  };
  /**
   * Read the bucket once, straight after a connection is made.
   *
   * Only when there is something to read: the check needs backups to be on and
   * the destination settled, and asking before that is a refusal the reader did
   * nothing to cause. A failure here is the useful kind - it is the connection
   * they just made, said plainly on the card while they are still looking at it.
   */
  const checkAfterConnect = async (config: R2Config | null) => {
    if (!config?.enabled || !config.configured) return;
    if (config.mode === 'cloudflare' && config.cloudflare?.state !== 'connected') return;
    await checkR2();
  };
  const uploadR2 = async () => {
    setR2Busy(t('console.r2UploadLatest'));
    setOperationProgress(null);
    try {
      const response = await apiFetch('/api/v1/r2/sync', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.r2UploadFailed'))); return; }
      // A first upload is gigabytes. It runs in the server and is followed the
      // same way a restore is, so the bar says how far it has got and the Stop
      // button reaches the work rather than only this page.
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh(); done(t('console.r2Uploaded'));
    } catch (error: unknown) {
      if (!(error instanceof StoppedError)) failed(error instanceof Error ? error.message : t('console.r2UploadFailed'));
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
  /**
   * Ask what to do with a recovery point, the way an archive is asked about.
   *
   * Its index says what it holds and how large each file is, which is all the
   * dialog needs - and in saver mode, whether it fits on this machine.
   */
  const openPointRestore = async (snapshot: R2SnapshotSummary) => {
    setR2Busy(t('console.restore'));
    try {
      const response = await apiFetch(`/api/v1/r2/snapshots/${encodeURIComponent(snapshot.id)}/preview`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ profileId: snapshot.profileId }) });
      const payload = await response.json() as RestorePreview | { error?: { message?: string } };
      if (!response.ok || !('files' in payload)) { failed(fail.body(payload, t('console.backupPreviewFailed'))); return; }
      setRestoreMode('replace'); setRestoreAnyway(false); setRestoreTrim(false);
      setRestorePoint(snapshot); setSelectedPreview(payload);
    } catch { failed(t('console.backupPreviewFailed')); } finally { setR2Busy(null); }
  };
  /**
   * Put a recovery point straight into the profile, saver mode's way back.
   *
   * No archive is made on the way; the progress is the download.
   */
  const restorePointInPlace = async (snapshot: R2SnapshotSummary, choice: { mode: RestoreMode; force: boolean; trim: boolean }) => {
    setR2Busy(t('console.restore')); setOperationProgress(null); setMixedProfile(null);
    try {
      const response = await apiFetch(`/api/v1/r2/snapshots/${encodeURIComponent(snapshot.id)}/restore`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ profileId: snapshot.profileId, mode: choice.mode, ...(choice.force ? { force: true } : {}), ...(choice.trim ? { trim: true } : {}) }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.backupRestoreFailed'))); return; }
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh();
      done(t('console.restoreDone'));
    } catch (error: unknown) {
      if (error instanceof StoppedError) { done(t('console.restoreStopped')); await refresh(); }
      else if (error instanceof RollbackFailedError) { setMixedProfile(t('console.restoreStoppedPartwaySaver')); await refresh(); }
      else failed(error instanceof Error ? error.message : t('console.backupRestoreFailed'));
    } finally { setR2Busy(null); setOperationProgress(null); setRunningJobId(null); }
  };
  const fetchSnapshot = async (snapshot: R2SnapshotSummary) => {
    setR2Busy(t('console.r2Fetch'));
    setOperationProgress(null);
    try {
      // Which profile in the bucket wrote it, which for a point from another
      // machine is not this one. The chunks are shared, so reading it from
      // there and restoring it here costs nothing extra.
      const response = await apiFetch(`/api/v1/r2/snapshots/${encodeURIComponent(snapshot.id)}/fetch`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ profileId: snapshot.profileId }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.r2FetchFailed'))); return; }
      setRunningJobId(payload.jobId);
      const finished = await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh();
      /*
       * Ask what to do with it, the way an uploaded zip is asked about.
       *
       * Bringing a recovery point back and restoring it are one intention,
       * split in two only because the archive has to exist before it can be
       * looked inside. Ending at a notification left the reader to go and find
       * the row themselves, in a list where the thing they had just downloaded
       * looked like everything else in it.
       */
      const landed = finished.resultBackupId ? await readBackup(finished.resultBackupId) : null;
      if (landed && await openRestoreFor(landed)) return;
      toast({ title: t('console.r2Fetched'), tone: 'success', duration: 8000 });
    } catch (error: unknown) {
      if (!(error instanceof StoppedError)) failed(error instanceof Error ? error.message : t('console.r2FetchFailed'));
    } finally { setR2Busy(null); setOperationProgress(null); setRunningJobId(null); }
  };
  /**
   * Take the bucket from the machine that holds it.
   *
  /**
   * Put back what another machine was set to - the settings alone.
   *
   * The console reloads afterwards rather than trying to reconcile what is on
   * screen with what has just changed underneath it: the password this session
   * signed in with may not be the password any more, and the honest thing to
   * do about that is to ask again.
   */
  const restoreManagerSettings = async () => {
    setR2Busy(t('console.r2SettingsRestore'));
    try {
      const response = await apiFetch('/api/v1/r2/settings/restore', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ passwords: true, schedules: true }) });
      const payload = await response.json() as { applied?: string[]; error?: { message?: string } };
      if (!response.ok || !payload.applied) { failed(fail.body(payload, t('console.r2SettingsRestoreFailed'))); return; }
      done(t('console.r2SettingsRestored'));
      window.setTimeout(() => { window.location.reload(); }, 1500);
    } catch { failed(t('console.r2SettingsRestoreFailed')); } finally { setR2Busy(null); }
  };
  const removeLegacy = async () => {
    setR2Busy(t('console.r2LegacyRemove'));
    try {
      const response = await apiFetch('/api/v1/r2/legacy', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { removed?: number; error?: { message?: string } };
      if (!response.ok) { failed(fail.body(payload, t('console.r2LegacyRemoveFailed'))); return; }
      await refresh(); done(t('console.r2LegacyRemoved'));
    } catch { failed(t('console.r2LegacyRemoveFailed')); } finally { setR2Busy(null); }
  };

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;
  const localChoice = backupSchedule ? LOCAL_BACKUP_CHOICES.find((choice) => choice.intervalMinutes === backupSchedule.intervalMinutes) : undefined;
  const displayName = (backup: BackupManifest) => backupDisplayName(t, locale, backup);
  const backupColumns: DataTableColumn<BackupManifest>[] = [
    // The kind rides under the name on a phone, where there is no room for a
    // column of its own, and has its column from `md` up.
    { id: 'name', header: t('common.name'), sortable: true, cell: (backup) => <span className="grid min-w-0 justify-items-start gap-1"><span className="font-medium break-all" title={backup.name}>{displayName(backup)}</span>{backup.note ? <span className="line-clamp-2 text-xs whitespace-pre-line text-muted-foreground" title={backup.note}>{backup.note}</span> : null}<span className="md:hidden"><BackupKindBadge t={t} kind={backupKind(backup)} /></span></span> },
    { id: 'kind', header: t('console.backupKind'), sortable: true, showFrom: 'md', cell: (backup) => <BackupKindBadge t={t} kind={backupKind(backup)} /> },
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
  const cloudflare = r2Config?.cloudflare ?? null;
  /*
   * Another manager signed in with this Cloudflare account, so this one is
   * out: it has given its own sign-in up and can reach nothing in that
   * account until somebody signs in here again. What the account holds is
   * hidden behind this rather than offered by a console that cannot read it.
   */
  const displaced = r2Config?.owner ? !r2Config.owner.mine : false;
  // The recovery this machine carried out on its own, before anybody
  // opened the console. Held here so the notice below can name it and the
  // button beside it can remember which one was waved away.
  const lastRecovery = r2Config?.lastRecovery ?? null;
  // Backups go through the signed-in account, as opposed to it merely being connected.
  const signedIn = r2Config?.mode === 'cloudflare' && cloudflare?.state === 'connected';
  const keysConfigured = Boolean(r2Config?.endpoint && r2Config.bucket && r2Config.accessKeyIdMasked && r2Config.secretAccessKeyConfigured);
  const destination = destinationText(t, r2Config);
  /*
   * When, how big, and the one thing to do with it.
   *
   * There used to be two more columns: which profile in the bucket wrote the
   * point, and how many files it holds. Neither is a question anybody asks of
   * this table - every row is the same person's data, and a file count says
   * nothing a size does not say better - and between them they took the width
   * that the three columns that are read need on a phone. The row now fits on
   * one line at any width.
   */
  const snapshotColumns: DataTableColumn<R2SnapshotSummary>[] = [
    {
      id: 'createdAt',
      header: t('console.backupCreated'),
      sortable: true,
      // Digits rather than the locale's long form below `sm`: "18:05
      // 18/09/2026" is half the width of what `toLocaleString` writes and is
      // read the same way in both languages.
      cell: (snapshot) => <span className="whitespace-nowrap">
        <span className="sm:hidden">{shortWhen(snapshot.createdAt)}</span>
        <span className="hidden sm:inline">{new Date(snapshot.createdAt).toLocaleString()}</span>
      </span>,
    },
    // The data the point holds, which is what bringing it back downloads. The
    // index object alone - what this column used to show - is a few hundred
    // kilobytes whatever the profile weighs.
    { id: 'dataBytes', header: t('console.backupSize'), sortable: true, align: 'end', cell: (snapshot) => <span className="whitespace-nowrap text-muted-foreground">{snapshot.dataBytes === null ? '—' : formatBytes(snapshot.dataBytes)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">{t('console.backupActions')}</span>,
      align: 'end',
      headClassName: 'w-28',
      // Not "Download": nothing leaves for the reader to carry off. The point
      // comes back into this manager's backup library, to be restored from there.
      // In saver mode there is no library to bring it into, so the row offers
      // what fetching was always the first half of: restoring it.
      cell: (snapshot) => saving
        ? <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={() => openPointRestore(snapshot)} disabled={r2Busy !== null}><RotateCcw />{t('console.restore')}</Button>
        : <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={() => fetchSnapshot(snapshot)} disabled={r2Busy !== null}><History />{t('console.r2Fetch')}</Button>,
    },
  ];

  return <div className="grid min-w-0 gap-4">
    {/* First on the page, because it is the reason to read the rest of it. It
        stops being shown once backups are leaving this machine: the storage is
        still temporary then, but it no longer costs the reader anything.

        Said about anything that is not plainly the reader's own computer, not
        only about a filesystem caught being temporary. This console recognises
        no hosting platform by name and so cannot vouch for any of them; an
        unverified machine is told about in the same words as one already known
        to be thrown away, because for the reader they are the same risk. */}
    {storage && storage.assurance !== 'durable' && !(r2Config?.enabled && r2Config.configured) ? <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{t('console.storageTemporaryTitle')}</AlertTitle>
      <AlertDescription className="grid gap-3">
        <span>{storage.machine ? t('console.storageTemporaryBody', { machine: storage.machine }) : t('console.storageTemporaryBodyUnnamed')}</span>
        {/* Straight to Cloudflare when nothing is connected yet, which is the
            one press this warning is asking for; the form otherwise, because
            whatever is half done is finished there. */}
        <span><Button size="sm" style={{ backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' }} className="hover:opacity-90" onClick={() => (cloudflare?.state === 'disconnected' ? connectCloudflare() : setDestinationOpen(true))} loading={cloudflareBusy}><CloudflareMark />{t('console.storageTemporaryConnect')}</Button></span>
      </AlertDescription>
    </Alert> : null}

    <Card>
      {/*
        * Whose backups these are, as a small control in the card's corner.
        *
        * It had a card of its own, with a "New profile" button beside it that
        * invited a press nearly nobody needs: somebody who made a second
        * profile out of curiosity found an empty library and asked where their
        * backups had gone, not knowing to switch back. Profiles are for the
        * few who keep separate libraries, so making one is the last line of
        * the dropdown rather than a button on the page.
        */}
      <PanelHeading icon={<Archive />} action={activeProfile === null ? null : <Select value={activeProfile.id} onValueChange={(id) => { if (id === NEW_PROFILE) setProfileOpen(true); else void activate(id); }} disabled={busy}>
        <SelectTrigger size="sm" className="profile-select" aria-label={t('console.switchProfile')}><UserRound className="text-muted-foreground" /><SelectValue /></SelectTrigger>
        <SelectContent position="popper" align="end">
          {profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
          <SelectSeparator />
          <SelectItem value={NEW_PROFILE} className="text-muted-foreground"><Plus />{t('console.newProfile')}</SelectItem>
        </SelectContent>
      </Select>}>{t('console.backupLibrary')}</PanelHeading>
      <CardContent className="grid gap-4">
        {/* Here rather than in the R2 settings: it runs whether or not there is
            a bucket, so it has to be reachable without one. */}
        {saving ? <Alert><Leaf /><AlertDescription>{t('console.saverLocalOff')}</AlertDescription></Alert> : backupSchedule ? <div>
          {/* On or off is a switch, the way every other on-or-off in the console
              is; how often is a separate question, asked only while it is on. */}
          <DetailRow label={t('console.localScheduleLabel')} {...(backupSchedule.intervalMinutes === 0 ? { hint: t('console.localScheduleOffHint') } : {})}>
            <Switch aria-label={t('console.localScheduleLabel')} checked={backupSchedule.intervalMinutes > 0} disabled={scheduleSaving} onCheckedChange={(on) => void saveBackupSchedule(on ? lastInterval.current : 0)} />
          </DetailRow>
          {/* A one-word label keeps its menu beside it on a phone: the row's usual
              room for a label is what pushed the menu to a line of its own. */}
          {backupSchedule.intervalMinutes > 0 ? <DetailRow label={t('console.localScheduleEvery')} className="[&>div:first-child]:basis-24">
            <Select value={localChoice?.id ?? CUSTOM_CHOICE} onValueChange={(id) => { const choice = LOCAL_BACKUP_CHOICES.find((item) => item.id === id); if (choice) void saveBackupSchedule(choice.intervalMinutes); }} disabled={scheduleSaving}>
              <SelectTrigger size="sm" className="w-40" aria-label={t('console.localScheduleEvery')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOCAL_BACKUP_CHOICES.map((choice) => <SelectItem key={choice.id} value={choice.id}>{t(choice.label)}</SelectItem>)}
                {localChoice ? null : <SelectItem value={CUSTOM_CHOICE} disabled>{t('console.everyMinutes', { minutes: backupSchedule.intervalMinutes })}</SelectItem>}
              </SelectContent>
            </Select>
          </DetailRow> : null}
        </div> : null}
        {mixedProfile ? <Alert variant="destructive"><AlertDescription>{mixedProfile}</AlertDescription></Alert> : null}
        {/* The three things to do here, in a row of their own above the list
            rather than squeezed in beside its search box, where they wrapped
            into a staircase at every width between a phone and a desktop.
            Uploading comes first and filled in: it is the one people come to
            this card to do. */}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <label className={cn(buttonVariants({ size: 'sm' }), 'cursor-pointer has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50')}>
            <Upload aria-hidden="true" />{t('console.importZip')}
            <input type="file" accept=".zip,application/zip" className="sr-only" disabled={busy} onChange={(event) => void inspectUpload(event.target.files?.[0])} />
          </label>
          {saving ? null : <>
            <Button variant="outline" size="sm" onClick={() => startBackup('scheduled').then((failure) => { if (failure) failed(failure); })} disabled={busy || activeProfileId === null}><DatabaseBackup />{t('dashboard.backupNow')}</Button>
            <Button variant="outline" size="sm" onClick={() => setBackupOpen(true)} disabled={busy || activeProfileId === null}><BookmarkPlus />{t('console.manualBackup')}</Button>
          </>}
        </div>
        {busyAction ? <OperationProgress t={t} label={busyAction} progress={operationProgress} canStop={uploading || runningJobId !== null} stopping={stopping} onStop={() => void stopOperation()} warning={uploading ? t('console.uploadKeepTabOpen') : null} /> : null}
        <DataTable
          rows={kindFilter === 'all' ? backups : backups.filter((backup) => backupKind(backup) === kindFilter)}
          columns={backupColumns}
          rowKey={(backup) => backup.id}
          query={backupQuery}
          onQueryChange={setBackupQuery}
          labels={labels}
          searchText={(backup) => `${displayName(backup)} ${backupSearchText(backup)}`}
          sortValue={(backup, column) => column === 'name' ? displayName(backup) : backupSortValue(backup, column)}
          empty={<EmptyState icon={<Archive />} title={t('dashboard.noBackup')} />}
          toolbar={<Select value={kindFilter} onValueChange={(value) => { setKindFilter(value as BackupKind | 'all'); setBackupQuery((current) => ({ ...current, page: 1 })); }}>
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={t('console.backupKind')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('console.backupKindAll')}</SelectItem>
              {BACKUP_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{t(BACKUP_KIND_LABEL[kind])}</SelectItem>)}
            </SelectContent>
          </Select>}
        />
      </CardContent>
    </Card>

    <Card className="cloud-card">
      <PanelHeading icon={<Cloud />}>
        {t('console.r2Title')}
        {/* The same mark the overview puts on the tunnel, for the same reason:
            of everything on this page, these two are what somebody who has not
            tried them is missing out on. */}
        <span className="access-badge"><Star />{t('console.r2Badge')}</span>
      </PanelHeading>
      <CardContent className="grid gap-4">
        {/* The address the dialog handed over, still here after the dialog has
            been closed on top of it. */}
        {cloudflareSignInUrl && !destinationOpen ? <CloudflareSignInNotice t={t} url={cloudflareSignInUrl} onDismiss={() => setCloudflareSignInUrl(null)} /> : null}
        {/* Said above the settings, and only while it is off: once it is on,
            this is a sales pitch for something the reader has already bought. */}
        {!(r2Config?.enabled && r2Config.configured) ? <p className="cloud-pitch">
          <ShieldCheck aria-hidden="true" />
          <span>{t('console.r2Pitch')}</span>
        </p> : null}
        {/*
          * An account that has never turned R2 on. Said first and said plainly,
          * because the sign-in worked, every permission asked for was granted,
          * and nothing else on this card can account for there still being no
          * bucket. It is also the only trouble here that is fixed somewhere
          * else, so it carries the way there.
          */}
        {cloudflare?.problem === 'r2_not_enabled' ? <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{t('console.cfR2NotEnabledTitle')}</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>{t('console.cfR2NotEnabledBody')}</span>
            <R2ActivationActions t={t} onRecheck={recheckR2} />
          </AlertDescription>
        </Alert> : null}
        {/*
          * The manager put this machine's data back by itself, before anybody
          * opened the console. Said here because it is otherwise
          * indistinguishable from a machine that happened to still have it.
          */}
        {/* Another manager signed in with this Cloudflare account and took
            it. Said at the top of every page rather than here: a console that
            has stopped backing up is not news about the backup card, and the
            reader may never open this page. */}
        {/*
          * Settings another machine left here, on their own.
          *
          * The card at the top of every page is the answer for somebody
          * putting a machine back together, and it is the whole of it: the
          * data, the release, the settings, the usage history. This is the
          * narrow version, for somebody who is already set up and wants only
          * the schedules and the passwords - which is a thing to come looking
          * for on the page about backups, not a thing to be offered.
          */}
        {settingsOffer?.available && !settingsOffer.mine && !displaced ? <Alert>
          <Settings2 />
          <AlertTitle>{t('console.r2SettingsTitle')}</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>{t('console.r2SettingsBody', { name: settingsOffer.label ?? '', when: settingsOffer.writtenAt ? new Date(settingsOffer.writtenAt).toLocaleString() : '' })}</span>
            {settingsOffer.hasAdminPassword ? <span className="text-xs">{t('console.r2SettingsPasswordWarning')}</span> : null}
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => restoreManagerSettings()} disabled={r2Busy !== null}>{t('console.r2SettingsRestore')}</Button>
              <Button size="sm" variant="ghost" disabled={r2Busy !== null} onClick={() => {
                const when = settingsOffer.writtenAt;
                if (when) saveDismissedSettings(when, browserStorage());
                setSettingsOffer({ ...settingsOffer, available: false });
                void apiFetch('/api/v1/r2/settings/dismiss', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
              }}>{t('console.r2SettingsDismiss')}</Button>
            </span>
          </AlertDescription>
        </Alert> : null}
        {lastRecovery && !displaced && shouldShowRecovery(lastRecovery.createdAt, dismissedRecovery) ? <Alert>
          <History />
          <AlertTitle>{t('console.r2RecoveredTitle')}</AlertTitle>
          {/* How much came back, not how many files: a size is something the
              reader can weigh against what they remember having. A recovery
              recorded before the size was kept says the rest without it,
              rather than claiming 0 B came back. */}
          <AlertDescription className="grid gap-2">
            <span>{lastRecovery.sizeBytes === undefined
              ? t('console.r2RecoveredBodyNoSize', { when: new Date(lastRecovery.createdAt).toLocaleString() })
              : t('console.r2RecoveredBody', { when: new Date(lastRecovery.createdAt).toLocaleString(), size: formatBytes(lastRecovery.sizeBytes) })}</span>
            {/* News about something that has already finished. Read once, it
                has nothing left to say, and without this it stayed on the page
                for the life of the installation. */}
            <span><Button size="sm" variant="ghost" onClick={() => {
              saveDismissedRecovery(lastRecovery.createdAt, browserStorage());
              setDismissedRecovery(lastRecovery.createdAt);
            }}>{t('common.gotIt')}</Button></span>
          </AlertDescription>
        </Alert> : null}
        <div>
          {/* Whether anything leaves this machine at all, first: it is the
              question everything else on the card only answers the details of.
              How often rides in the same row, as its hint, because the interval
              is only a question while the answer to this one is yes. */}
          <DetailRow
            label={t('console.r2Enabled')}
            hint={displaced ? t('console.r2DisplacedHint', { name: r2Config?.owner?.label ?? '' }) : !r2Config?.configured ? t('console.r2NeedsSetup') : r2Config.enabled ? r2ScheduleSummary(t, r2Config) : t('console.r2EnabledOffHint')}
          >
            {r2Config?.configured && r2Config.enabled
              ? <Button variant="outline" size="sm" onClick={() => setR2ScheduleOpen(true)}>{t('console.r2Change')}</Button>
              : null}
            {/* Pressable with nothing set up, because pressing it is how somebody
                says they want this on - and the form that makes it possible is
                what that press should open. A switch that is simply dead, with a
                sentence underneath naming a prerequisite, leaves the reader to
                find the prerequisite themselves. Closed without finishing, the
                switch goes back to off: nothing was turned on. */}
            <Switch
              aria-label={t('console.r2Enabled')}
              checked={(r2Config?.enabled ?? false) && (r2Config?.configured ?? false)}
              disabled={r2Toggling}
              onCheckedChange={(checked) => { if (checked && !r2Config?.configured) setDestinationOpen(true); else void setR2Enabled(checked); }}
            />
          </DetailRow>
          {/* Then where it goes. One row whichever way the bucket is reached,
              because it is one question; the two ways of answering it are both
              inside the one form behind this button. */}
          <DetailRow label={t('console.r2Destination')} hint={destination}>
            {r2Config?.configured || displaced
              ? <Button variant="outline" size="sm" onClick={() => setDestinationOpen(true)}>{t('console.r2Change')}</Button>
              : <Button size="sm" onClick={() => setDestinationOpen(true)}><Cloud />{t('console.r2DestinationSet')}</Button>}
          </DetailRow>
          {/* Then the two things there are to do with a bucket: send to it now,
              and look at it. Everything else that used to be a button here
              answered some part of "look at it" and is folded into Check. */}
          {r2Config?.configured ? <DetailRow label={t('console.r2LastUpload')} hint={r2Config.lastUploadAt ? new Date(r2Config.lastUploadAt).toLocaleString() : '—'}>
            {/* Side by side, and one under the other only on a phone. Two
                buttons in a row need more width than the card has on a narrow
                screen, and what gives way there is the label beside them - but
                a desktop card has the width, and stacking them there left a
                column of two short buttons against a row with a name on it. */}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="sm" onClick={() => uploadR2()} disabled={r2Busy !== null || !r2Config.enabled}><CloudUpload />{t('console.r2UploadLatest')}</Button>
              <Tooltip><TooltipTrigger asChild><span className="inline-flex">
                <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => checkR2()} disabled={r2Busy !== null}><ShieldCheck />{t('console.r2CheckNow')}</Button>
              </span></TooltipTrigger><TooltipContent>{t('console.r2CheckHint')}</TooltipContent></Tooltip>
            </div>
            {/* Backups taken under the old whole-file scheme. Nothing reads them
                any more, but they are the operator's, so removing them is asked
                for rather than assumed - and this menu exists only when there
                is something in it. */}
            {r2Config.usage.legacyObjectCount > 0 ? <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('console.r2More')} disabled={r2Busy !== null}><Ellipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => void removeLegacy()}><Trash2 />{t('console.r2LegacyRemove')} ({formatBytes(r2Config.usage.legacyBytes)})</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu> : null}
          </DetailRow> : null}
        </div>
        {/* What the last look at the bucket found, kept where the reader was
            looking when they asked for it. */}
        {r2Check ? <R2CheckLine t={t} check={r2Check} /> : null}
        {r2Busy ? <OperationProgress t={t} label={r2Busy} progress={operationProgress} canStop={runningJobId !== null} stopping={stopping} onStop={() => void stopOperation()} warning={null} /> : null}
        {signedIn && cloudflare?.restReason ? <Alert><TriangleAlert /><AlertDescription>{t(cloudflare.restReason === 'workers_not_granted' ? 'console.cfSlowNotGranted' : 'console.cfSlowUnavailable')}</AlertDescription></Alert> : null}
        {r2Config?.configured && activeProfile === null && r2Snapshots.length > 0
          ? <Alert><Cloud /><AlertDescription>{t('console.r2AwaitingInstall', { count: r2Snapshots.length })}</AlertDescription></Alert>
          : r2Config?.configured && r2Config.lastUploadAt === null && r2Snapshots.length > 0
            ? <Alert><Cloud /><AlertDescription>{t('console.cfNewMachine', { count: r2Snapshots.length })}</AlertDescription></Alert>
            : null}
        {r2Config?.configured ? <>
          {/* One set of figures, not two: Cloudflare's own when it can be asked,
              because it sees every machine on the bucket, and the manager's
              count when it cannot. */}
          {signedIn
            ? <CloudflareUsagePanel t={t} lastUploadAt={r2Config.lastUploadAt} fallback={<R2Usage t={t} config={r2Config} />} onRegisterRefresh={(fn) => { usageRefresh.current = fn; }} />
            : <R2Usage t={t} config={r2Config} />}
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">{t('console.r2Snapshots')}</h3>
            <DataTable
              rows={r2Snapshots}
              columns={snapshotColumns}
              rowKey={(snapshot) => `${snapshot.profileId}/${snapshot.id}`}
              query={snapshotQuery}
              onQueryChange={setSnapshotQuery}
              labels={labels}
              sortValue={snapshotSortValue}
              pageSizes={[5, 10, 25]}
              empty={<EmptyState icon={<Cloud />} title={t('console.r2NoSnapshots')} description={t('console.r2NoSnapshotsBody')} />}
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
      description={t('console.newProfileBody')}
      label={t('console.profileName')}
      placeholder={t('console.profileNamePlaceholder')}
      submitLabel={t('common.create')}
      onSubmit={createProfile}
    />
    <NameDialog
      t={t}
      open={backupOpen}
      onOpenChange={setBackupOpen}
      title={t('console.manualBackup')}
      label={t('console.backupNameLabel')}
      hint={t('console.backupNameHint')}
      note={{ label: t('console.backupNoteLabel'), hint: t('console.backupNoteHint') }}
      submitLabel={t('console.manualBackup')}
      optional
      onSubmit={(name, note) => startBackup('manual', name, note)}
    />
    <NameDialog
      t={t}
      open={renameTarget !== null}
      onOpenChange={(next) => { if (!next) setRenameTarget(null); }}
      title={t('console.renameBackupTitle')}
      label={t('common.name')}
      initial={renameTarget ? displayName(renameTarget).replace(/\.zip$/u, '') : ''}
      submitLabel={t('common.rename')}
      onSubmit={renameBackup}
    />
    <ConfirmDialog
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
      title={t('console.deleteBackupTitle', { name: deleteTarget ? displayName(deleteTarget) : '' })}
      description={t('console.deleteBackupBody')}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      onConfirm={deleteBackup}
    />
    <RestoreDialog t={t} catalog={catalog} name={streaming ? streaming.file.name : restorePoint ? t('console.restorePointName', { when: new Date(restorePoint.createdAt).toLocaleString() }) : selectedBackup ? displayName(selectedBackup) : null} safety={t(saving ? 'console.restoreSafetySaver' : 'console.restoreSafety')} preview={selectedPreview} mode={restoreMode} onModeChange={setRestoreMode} anyway={restoreAnyway} onAnywayChange={setRestoreAnyway} trim={restoreTrim} onTrimChange={setRestoreTrim} onClose={closeRestore} onRestore={restoreSelected} />
    <R2DestinationDialog
      t={t}
      open={destinationOpen}
      onOpenChange={setDestinationOpen}
      startEnabled={!r2Config?.enabled}
      config={r2Config}
      busy={cloudflareBusy}
      signInUrl={cloudflareSignInUrl}
      onDismissSignIn={() => setCloudflareSignInUrl(null)}
      onConnect={() => void connectCloudflare()}
      onChooseAccount={chooseCloudflareAccount}
      onChooseBucket={chooseCloudflareBucket}
      onDisconnect={() => setDisconnectOpen(true)}
      onRecheckR2={recheckR2}
      onUseCloudflare={backUpToCloudflare}
      onSaveKeys={saveR2Keys}
    />
    <R2ScheduleDialog t={t} open={r2ScheduleOpen} onOpenChange={setR2ScheduleOpen} config={r2Config} onSave={saveR2Schedule} />
    <ConfirmDialog
      open={disconnectOpen}
      onOpenChange={setDisconnectOpen}
      title={t('console.cfDisconnectTitle')}
      description={t('console.cfDisconnectBody')}
      confirmLabel={t('console.cfDisconnect')}
      cancelLabel={t('common.cancel')}
      onConfirm={disconnectCloudflare}
    />
  </div>;
}

/** Where backups go, in the reader's words, whichever way the bucket is reached. */
function destinationText(t: Translate, config: R2Config | null): string {
  /*
   * A machine that has lost the account still has a destination.
   *
   * It is connected to nothing, so `configured` is false and this line said
   * "nowhere yet" - over a bucket holding a year of this reader's chats,
   * beside a notice at the top of the page naming the account it had just
   * been locked out of. What it has lost is permission, not the address.
   */
  const lost = config?.mode === 'cloudflare' ? config.cloudflare?.displacedBy ?? null : null;
  if (lost) {
    return t('console.r2DestinationLost', {
      bucket: config?.cloudflare?.bucket ?? t('console.r2DestinationUnnamed'),
      account: config?.cloudflare?.account?.name ?? '',
      name: lost,
    });
  }
  if (!config?.configured) return t('console.r2DestinationNone');
  const bucket = (config.mode === 'cloudflare' ? config.cloudflare?.bucket : config.bucket) || t('console.r2DestinationUnnamed');
  return config.mode === 'cloudflare'
    ? t('console.r2DestinationCloudflare', { bucket, account: config.cloudflare?.account?.name ?? '' })
    : t('console.r2DestinationKeys', { bucket });
}

/** Cloudflare's own R2 page, where an account that has not enabled R2 enables it. */
const CLOUDFLARE_R2_URL = 'https://dash.cloudflare.com/?to=/:account/r2/overview';

/**
 * What the last look at the bucket found.
 *
 * One line, in the place the button that asked for it is, and it stays until
 * something replaces it. The three buttons this replaced each answered in a
 * notification that was gone in a few seconds, which meant the reader could
 * press a button, look away, and be left exactly as uncertain as before.
 */
type R2Activation =
  | { readonly state: 'enabled'; readonly config: R2Config }
  | { readonly state: 'still_off' }
  | { readonly state: 'failed'; readonly payload: unknown };

/**
 * Choose the account again, which is how a bucket gets made once R2 is on.
 *
 * The connection keeps the account that failed for exactly this, so nothing
 * has to be picked a second time.
 */
async function recheckR2Activation(csrfToken: string): Promise<R2Activation> {
  try {
    const current = await apiFetch('/api/v1/r2', { credentials: 'same-origin' });
    const accountId = current.ok ? (await current.json() as { config: R2Config }).config.cloudflare?.account?.id : undefined;
    if (!accountId) return { state: 'failed', payload: null };
    const response = await apiFetch('/api/v1/r2/cloudflare/account', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ accountId }) });
    const payload = await response.json().catch(() => null) as { config?: R2Config; error?: { code?: string } } | null;
    if (response.ok && payload?.config?.cloudflare?.state === 'connected') return { state: 'enabled', config: payload.config };
    if (payload?.error?.code === 'cloudflare_r2_not_enabled') return { state: 'still_off' };
    return { state: 'failed', payload };
  } catch {
    return { state: 'failed', payload: null };
  }
}

/** How often coming back to the tab may ask Cloudflare again. */
const R2_RECHECK_GAP_MS = 5000;

/**
 * The way to R2 on Cloudflare, and the way back from it.
 *
 * The link went to Cloudflare and that was all: somebody who turned R2 on and
 * came back found the same warning, with nothing to say they had done it. Now
 * there is a button for that, and the page asks by itself whenever the tab
 * comes back into view - which is what finishing over there looks like from
 * here.
 */
function R2ActivationActions({ t, onRecheck }: { t: Translate; onRecheck: (quiet?: boolean) => Promise<void> }) {
  const last = useRef(0);
  const latest = useRef(onRecheck);
  latest.current = onRecheck;
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last.current < R2_RECHECK_GAP_MS) return;
      last.current = Date.now();
      void latest.current(true);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
  }, []);
  return <span className="flex flex-wrap items-center gap-2">
    <Button size="sm" asChild style={{ backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' }} className="hover:opacity-90">
      <a href={CLOUDFLARE_R2_URL} target="_blank" rel="noopener noreferrer"><CloudflareMark />{t('console.cfR2NotEnabledAction')}</a>
    </Button>
    <Button size="sm" variant="outline" onClick={() => { last.current = Date.now(); return onRecheck(false); }}><RefreshCw />{t('console.cfR2Recheck')}</Button>
  </span>;
}

function R2CheckLine({ t, check }: { t: Translate; check: R2CheckResult }) {
  const when = new Date(check.checkedAt);
  const fresh = Date.now() - when.getTime() < 60_000;
  if (!check.failure) {
    return <p className="text-xs text-muted-foreground">
      <span className="font-medium text-(--success)">{fresh ? t('console.r2CheckedJustNow') : t('console.r2CheckedAt', { time: when.toLocaleTimeString() })}</span>
      {' \u00b7 '}
      {t('console.r2CheckOk', { size: formatBytes(check.totalBytes), points: check.snapshotCount.toLocaleString() })}
    </p>;
  }
  return <Alert variant="destructive"><TriangleAlert /><AlertDescription>{t('console.r2CheckFailed', { error: check.failure.message })}</AlertDescription></Alert>;
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
      <TaskLine task={label} step={progress?.step ?? t('console.taskPreparing')} {...(progress ? { percent: progress.percent } : {})} />
      {canStop ? <Button variant="destructive" size="sm" onClick={onStop} loading={stopping}><CircleStop />{stopping ? t('console.stopping') : t('common.stop')}</Button> : null}
    </div>
    <TaskBar {...(progress ? { percent: Math.max(2, progress.percent) } : {})} />
    {warning ? <span className="text-xs text-destructive">{warning}</span> : null}
  </div>;
}

/**
 * What kind of work this is, what it is doing, and how far it has got.
 *
 * The kind is a small label of its own - Install, Start, Backup, Restore - so
 * a glance says which of the manager's few jobs is running before the sentence
 * says which part of it. The sentence carries the sweep, the way a reply being
 * written does, because a sentence that is visibly still being worked on is
 * easier to wait on than a bar alone.
 */
function TaskLine({ task, step, percent }: { task: string; step: string; percent?: number }) {
  return <span className="task-line">
    <span className="task-kind">{task}</span>
    <span className="thinking task-step">{step}</span>
    {percent === undefined ? null : <span className="task-percent">{Math.round(percent)}%</span>}
  </span>;
}

/**
 * A bar for work in progress: striped and moving, filled to the share done
 * when that is known and all the way when it is not. The meters that are
 * readings rather than work - CPU, memory, storage, the R2 allowance - keep
 * their plain bars.
 */
function TaskBar({ percent }: { percent?: number }) {
  return <span className="progress-track task-track">
    <span className="task-stripes" data-indeterminate={percent === undefined || undefined} style={percent === undefined ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }} />
  </span>;
}

/**
 * Work the manager started for itself, while it is running.
 *
 * Everything on this console that takes minutes used to be something somebody
 * pressed, and so was reported on the card they pressed it on. A machine that
 * has just been opened with a Cloudflare account starts an install and a
 * download of the whole profile without being asked - which is the point of
 * signing in that way - and there was no card, because there had been no
 * press. The reader got one line in the log and an Overview with nothing on
 * it, for as long as several gigabytes take.
 *
 * So it is said where they are: what is running, how far it has got, and the
 * step it is on. Stopping it is on the Data page, under the card it belongs
 * to, which is also where this is left out to avoid saying it twice.
 */
function BackgroundTaskCard({ t, catalog, job }: { t: Translate; catalog: Record<string, unknown>; job: Job }) {
  return <Card className="rounded-2xl">
    <CardContent className="grid gap-2.5 p-4">
      <TaskLine task={jobLabel(t, job.kind)} step={translateStep(job.step, catalog, job.stepCode, job.stepParams)} percent={job.progress} />
      <TaskBar percent={job.progress} />
    </CardContent>
  </Card>;
}

/** A field's name, and a quiet word beside it when it can be left empty. */
function FieldLabel({ label, optional }: { label: string; optional: string }) {
  return <span className="flex items-center gap-1.5">{label}<span className="text-xs font-normal text-muted-foreground">({optional})</span></span>;
}

/**
 * One field, and the button that uses it.
 *
 * Naming a new profile, naming a backup and renaming one are the same question
 * asked three times. None of them is `window.prompt` any more, which could not
 * be translated, could not be styled, and asked in the browser's voice rather
 * than this program's.
 */
function NameDialog({ t, open, onOpenChange, title, description, label, hint, placeholder, note, initial = '', submitLabel, optional = false, onSubmit }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; title: string; /** What the thing being named is, when that is not obvious. */ description?: string; label: string; hint?: string; placeholder?: string; /** A second, free-text field under the name, for a line about why. */ note?: { label: string; hint: string }; initial?: string; submitLabel: string; optional?: boolean; onSubmit: (name: string, note: string) => Promise<string | null> }) {
  const [name, setName] = useState(initial);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog stays mounted, so what was typed last time is cleared on the way
  // in rather than on the way out: a rename has to open on the name of the row
  // that was actually pressed.
  useEffect(() => { if (open) { setName(initial); setNoteText(''); setError(null); } }, [open, initial]);
  const ready = optional || name.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      const failure = await onSubmit(name.trim(), noteText.trim());
      setError(failure);
      if (!failure) onOpenChange(false);
    } finally { setBusy(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{title}</DialogTitle>{description ? <DialogDescription>{description}</DialogDescription> : null}</DialogHeader>
      <DialogBody className="grid gap-4">
        <Field label={optional ? <FieldLabel label={label} optional={t('common.optional')} /> : label} hint={hint}>
          <Input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} autoComplete="off" {...(placeholder ? { placeholder } : {})} />
        </Field>
        {note ? <Field label={<FieldLabel label={note.label} optional={t('common.optional')} />} hint={note.hint}>
          <Textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} rows={3} maxLength={500} className="max-h-40 resize-none" />
        </Field> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => submit()} disabled={busy || !ready}>{submitLabel}</Button>
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
function RestoreDialog({ t, catalog, name, safety, preview, mode, onModeChange, anyway, onAnywayChange, trim, onTrimChange, onClose, onRestore }: { t: Translate; catalog: Record<string, unknown>; name: string | null; safety: string; preview: RestorePreview | null; mode: RestoreMode; onModeChange: (mode: RestoreMode) => void; anyway: boolean; onAnywayChange: (anyway: boolean) => void; trim: boolean; onTrimChange: (trim: boolean) => void; onClose: () => void; onRestore: () => Promise<void> }) {
  const group = useId();
  const anywayId = useId();
  const trimId = useId();
  if (name === null || !preview) return null;
  /*
   * Whether it fits, in saver mode; see RestoreCapacity.
   *
   * Too large whole but not without its junk, the restore waits for the
   * reader to agree to leave the junk out - nothing they would miss, but it
   * is their data and their call. Too large either way, it is refused: the
   * alternative is a machine that stops halfway through.
   */
  const capacity = preview.capacity?.[mode] ?? null;
  const blockedBySize = capacity !== null && !(trim ? capacity.fitsTrimmed : capacity.fits);
  /*
   * An archive that is not a profile is refused here rather than restored.
   *
   * A replace deletes everything the archive does not mention, so restoring
   * the wrong zip does not restore anything - it empties the profile. It used
   * to be a line of small print under the buttons, which is the shape of a
   * remark rather than of a question, and the button beside it was ready to
   * press.
   *
   * An older manager answers without saying either way, and that is read as
   * recognised: there was nothing else it could have meant.
   */
  const unrecognized = preview.recognized === false;
  /*
   * Replace is the one to reach for, and says so.
   *
   * It leaves the profile exactly as the backup was. Merge keeps whatever the
   * backup does not mention, so the result is a mixture nobody took a backup
   * of - occasionally what is wanted, usually not.
   */
  /*
   * With the junk left out, the heading says what is actually restored: the
   * archive's count struck through, and what remains of it beside an arrow.
   */
  const trimmed = trim && capacity && capacity.junkFiles > 0 ? capacity : null;
  /*
   * What a replace takes away, said before it does.
   *
   * Replacing with an older backup deletes everything added since, and the
   * one line describing Replace does not say how much that is. Extensions are
   * named: a missing chat is noticed, a missing extension looks like a bug.
   */
  const losses = mode === 'replace' && preview.losses && preview.losses.files > 0 ? preview.losses : null;
  const options: Array<{ value: RestoreMode; label: string; body: string; recommended: boolean }> = [
    { value: 'replace', label: t('console.replaceRestore'), body: t('console.restoreReplaceBody'), recommended: true },
    { value: 'merge', label: t('console.mergeRestore'), body: t('console.restoreMergeBody'), recommended: false },
  ];
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('console.restoreTitle', { name })}</DialogTitle>
        <DialogDescription>{trimmed
          ? <span className="flex flex-wrap items-center gap-x-1.5">
            <span className="line-through">{t('console.restoreCounts', { files: preview.fileCount, size: formatBytes(preview.totalBytes) })}</span>
            <ArrowRight className="size-3.5" aria-hidden />
            <span className="font-medium text-foreground">{t('console.restoreCounts', { files: preview.fileCount - trimmed.junkFiles, size: formatBytes(preview.totalBytes - trimmed.junkBytes) })}</span>
          </span>
          : t('console.restoreCounts', { files: preview.fileCount, size: formatBytes(preview.totalBytes) })}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <RadioGroup value={mode} onValueChange={(value) => onModeChange(value as RestoreMode)} aria-label={t('console.restoreChoose')}>
          {options.map((option) => <div key={option.value} className="flex items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
            <RadioGroupItem id={`${group}-${option.value}`} value={option.value} className="mt-0.5" />
            <div className="grid gap-1">
              <Label htmlFor={`${group}-${option.value}`} className="flex flex-wrap items-center gap-2 font-medium">{option.label}{option.recommended ? <Badge variant="secondary" className="bg-(--success-background) text-(--success)">{t('console.restoreRecommended')}</Badge> : null}</Label>
              <p className="text-xs text-muted-foreground">{option.body}</p>
            </div>
          </div>)}
        </RadioGroup>
        {losses
          ? <Alert>
            <TriangleAlert />
            <AlertDescription className="grid gap-2">
              <span>{t('console.restoreLosses', { files: losses.files, size: formatBytes(losses.bytes) })}</span>
              {losses.extensions.length > 0 ? <>
                <span>{t('console.restoreLostExtensions')}</span>
                <span className="flex flex-wrap gap-1.5">{losses.extensions.map((extension) => <Badge key={extension} variant="outline" className="font-mono">{extension}</Badge>)}</span>
              </> : null}
              <span>{t('console.restoreLossesKeep')}</span>
            </AlertDescription>
          </Alert>
          : null}
        {preview.warnings.length > 0
          ? <Alert variant={unrecognized ? 'destructive' : 'default'}>
            <AlertDescription className="grid gap-2">
              <span>{preview.warnings.map((warning) => translateStep(warning.message, catalog, warning.code, warning.params)).join(' ')}</span>
              {unrecognized ? <>
                <span>{t('console.restoreUnknownBody')}</span>
                <Label htmlFor={anywayId} className="flex items-start gap-2 font-normal">
                  <Checkbox id={anywayId} checked={anyway} onCheckedChange={(checked) => onAnywayChange(checked === true)} className="mt-0.5" />
                  <span>{t('console.restoreUnknownAnyway')}</span>
                </Label>
              </> : null}
            </AlertDescription>
          </Alert>
          : null}
        {capacity && !capacity.fitsTrimmed
          ? <Alert variant="destructive"><AlertDescription>{t('console.restoreTooLarge', { needed: formatBytes(capacity.trimmedNeededBytes), available: formatBytes(capacity.availableBytes) })}</AlertDescription></Alert>
          : capacity && capacity.junkBytes > 0
            ? <Alert variant={capacity.fits ? 'default' : 'destructive'}>
              <AlertDescription className="grid gap-2">
                <span>{capacity.fits
                  ? t('console.restoreJunkOptional', { junk: formatBytes(capacity.junkBytes), files: capacity.junkFiles })
                  : t('console.restoreJunkNeeded', { needed: formatBytes(capacity.neededBytes), available: formatBytes(capacity.availableBytes), junk: formatBytes(capacity.junkBytes), files: capacity.junkFiles })}</span>
                <Label htmlFor={trimId} className="flex items-start gap-2 font-normal">
                  <Checkbox id={trimId} checked={trim} onCheckedChange={(checked) => onTrimChange(checked === true)} className="mt-0.5" />
                  <span>{t('console.restoreTrim')}</span>
                </Label>
              </AlertDescription>
            </Alert>
            : null}
        {/* What it will use, once what is chosen fits; nothing to say when it
            frees more than it writes. */}
        {capacity && !blockedBySize && (trim ? capacity.trimmedNeededBytes : capacity.neededBytes) > 0
          ? <p className="text-xs text-muted-foreground">{t('console.restoreRoom', { needed: formatBytes(trim ? capacity.trimmedNeededBytes : capacity.neededBytes), available: formatBytes(capacity.availableBytes) })}</p>
          : null}
        <p className="text-xs text-muted-foreground">{safety}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant={mode === 'replace' ? 'destructive' : 'default'} disabled={(unrecognized && !anyway) || blockedBySize} onClick={() => onRestore()}>{t('console.restoreStart')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * One line saying the sign-in window was blocked, and where the press goes now.
 *
 * Cloudflare's sign-in refuses to load in a frame, so a console shown inside
 * another page opens a window for it - and some frames are not allowed to open
 * windows at all. This used to be a banner carrying a title, the whole
 * authorization address in monospace, an Open button, a Copy button and a
 * Close: a paragraph of screen and a wall of query string, for something that
 * ends in one press.
 *
 * And the press always worked. The address was fine; the browser simply would
 * not let a script open it, while an ordinary link the reader presses
 * themselves opens every time. So the address goes onto the button that was
 * pressed in the first place - `url` here, and the Cloudflare button itself
 * where there is one - and this is left saying the one thing the reader could
 * not have guessed: press it again.
 */
function CloudflareSignInNotice({ t, url, onDismiss }: { t: Translate; url?: string | null; onDismiss: () => void }) {
  return <Alert>
    <CloudflareMark />
    <AlertDescription className="flex flex-wrap items-center gap-2">
      <span className="mr-auto">{t(url ? 'console.cfConnectOpenHere' : 'console.cfConnectPopupBlocked')}</span>
      {url ? <Button size="sm" asChild><a href={url} target="_blank" rel="noopener noreferrer"><ArrowUpRight />{t('console.openInTab')}</a></Button> : null}
      <Button variant="ghost" size="sm" onClick={onDismiss}>{t('common.close')}</Button>
    </AlertDescription>
  </Alert>;
}

/**
 * Where backups go, asked once, with both ways of answering it in view.
 *
 * There is one question here - which bucket, reached how - and the card used to
 * ask it as two rows that each had a state, a hint and a button of their own:
 * a Cloudflare row with five shapes and a keys row with three, plus two
 * confirmations for moving between them and a third dialog for the bucket. A
 * reader who had signed in was still being shown a row inviting them to go and
 * copy keys, and a reader who had entered keys was shown the other. Neither row
 * said which one the backups were actually going through without being read
 * carefully.
 *
 * It is one form now. Two answers side by side, the one in force marked as
 * such, and everything each answer needs - signing in, picking an account,
 * picking a bucket, signing out, the four fields - inside the answer it belongs
 * to. Saving means "use this one", which is the choice that used to need a
 * confirmation dialog of its own, asked here where it is being made.
 */
function R2DestinationDialog({ t, open, onOpenChange, config, busy, startEnabled, signInUrl, onDismissSignIn, onConnect, onChooseAccount, onChooseBucket, onDisconnect, onRecheckR2, onUseCloudflare, onSaveKeys }: {
  t: Translate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: R2Config | null;
  busy: boolean;
  /** Opened by a switch somebody just turned on, so finishing here turns it on. */
  startEnabled: boolean;
  /** Set when this page could not open Cloudflare's sign-in and handed it over instead. */
  signInUrl: string | null;
  onDismissSignIn: () => void;
  onConnect: () => void;
  onChooseAccount: (accountId: string) => Promise<string | null>;
  onChooseBucket: (name: string) => Promise<string | null>;
  onDisconnect: () => void;
  onRecheckR2: (quiet?: boolean) => Promise<void>;
  onUseCloudflare: () => Promise<void>;
  onSaveKeys: (form: R2KeysForm & { readonly enabled?: boolean }) => Promise<string | null>;
}) {
  const group = useId();
  const cloudflare = config?.cloudflare ?? null;
  const mode = config?.mode ?? 'keys';
  /*
   * Which answer the form opens on.
   *
   * Whatever is already carrying the backups, and the sign-in when nothing is.
   * It used to open on the keys - the stored default before anything had been
   * chosen - which put four empty fields in front of somebody on a form whose
   * recommended answer, one line above, was greyed out until they had already
   * done the thing the form was for.
   */
  const [choice, setChoice] = useState<R2ConnectionMode>(mode);
  const [keys, setKeys] = useState<R2KeysForm>(() => r2KeysFrom(config));
  const [account, setAccount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog stays mounted, so what was typed last time is cleared on the way
  // in. Opening it after a sign-in that is waiting on a choice of account opens
  // it on the Cloudflare side, which is the side that is waiting.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setKeys(r2KeysFrom(config));
    setAccount(cloudflare?.accounts[0]?.id ?? '');
    setChoice(!cloudflare ? 'keys' : config?.configured ? mode : 'cloudflare');
  }, [open]);

  // Set in `.env`: shown so the reader knows where the value comes from, and
  // not editable, because the server reads `.env` on every start and would
  // ignore the edit.
  const fromEnvironment = new Set<string>(config?.environmentFields ?? []);
  const keysReady = Boolean(keys.endpoint.trim() && keys.bucket.trim() && keys.accessKeyId.trim() && (keys.secretAccessKey.trim() || config?.secretAccessKeyConfigured));
  const connected = cloudflare?.state === 'connected';
  // Choosing the sign-in is allowed before signing in - that is how somebody
  // says which way they want to go. What waits for it is Save, because there is
  // no bucket to save yet, and the row below says so rather than leaving a dead
  // button to be puzzled over.
  const canSave = choice === 'keys' ? keysReady : connected;
  const cloudflarePending = choice === 'cloudflare' && Boolean(cloudflare) && !connected;

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true); setError(null);
    try {
      // Saving is choosing. Keys are sent with the mode that uses them; the
      // sign-in has nothing to send but the choice itself.
      if (choice === 'keys') {
        const failure = await onSaveKeys({ ...keys, ...(startEnabled ? { enabled: true } : {}) });
        setError(failure);
        if (failure) return;
      } else if (mode !== 'cloudflare' || startEnabled) {
        await onUseCloudflare();
      }
      onOpenChange(false);
    } finally { setSaving(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('console.r2DestinationTitle')}</DialogTitle>
        <DialogDescription>{t('console.r2DestinationBody')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        {fromEnvironment.size > 0 ? <Alert><AlertDescription>{t('console.r2FromEnv')}</AlertDescription></Alert> : null}
        {signInUrl ? <CloudflareSignInNotice t={t} onDismiss={onDismissSignIn} /> : null}
        <RadioGroup value={choice} onValueChange={(value) => setChoice(value as R2ConnectionMode)} aria-label={t('console.r2DestinationTitle')}>
          {/* Signing in first, and marked as the one to reach for: it makes the
              bucket, keeps its own keys and is the only one that can show what
              Cloudflare says the account has used. */}
          {cloudflare ? <div className="grid gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
            <div className="flex items-start gap-3">
              <RadioGroupItem id={`${group}-cloudflare`} value="cloudflare" className="mt-0.5" />
              <div className="grid gap-1">
                <Label htmlFor={`${group}-cloudflare`} className="flex flex-wrap items-center gap-2 font-medium">
                  <CloudflareMark />{t('console.r2MethodCloudflare')}
                  <Badge variant="secondary" className="bg-(--success-background) text-(--success)">{t('console.r2Recommended')}</Badge>
                  {mode === 'cloudflare' && connected ? <Badge variant="outline">{t('console.r2MethodInUse')}</Badge> : null}
                </Label>
                <p className="text-xs text-muted-foreground">{t('console.r2MethodCloudflareBody')}</p>
              </div>
            </div>
            <CloudflareMethod
              t={t}
              status={cloudflare}
              busy={busy || saving}
              account={account}
              onAccountChange={setAccount}
              onConnect={onConnect}
              signInUrl={signInUrl}
              onChooseAccount={async () => { setError(await onChooseAccount(account)); }}
              onChooseBucket={async (name) => { setError(await onChooseBucket(name)); }}
              onDisconnect={onDisconnect}
              onRecheckR2={onRecheckR2}
            />
          </div> : null}
          <div className="grid gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
            <div className="flex items-start gap-3">
              <RadioGroupItem id={`${group}-keys`} value="keys" className="mt-0.5" />
              <div className="grid gap-1">
                <Label htmlFor={`${group}-keys`} className="flex flex-wrap items-center gap-2 font-medium">
                  {t('console.r2MethodKeys')}
                  {mode === 'keys' && config?.configured ? <Badge variant="outline">{t('console.r2MethodInUse')}</Badge> : null}
                </Label>
                <p className="text-xs text-muted-foreground">{t('console.r2MethodKeysBody')}</p>
              </div>
            </div>
            {/* The fields are here rather than behind a further button: this is
                already the form for answering the question, and a form that
                opens a second form to be filled in is one step too many. */}
            {choice === 'keys' ? <div className="grid gap-3">
              <Field label={t('console.r2Endpoint')}><Input value={keys.endpoint} onChange={(event) => setKeys({ ...keys, endpoint: event.target.value })} placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com" autoComplete="off" disabled={fromEnvironment.has('endpoint')} /></Field>
              <Field label={t('console.r2Bucket')}><Input value={keys.bucket} onChange={(event) => setKeys({ ...keys, bucket: event.target.value })} autoComplete="off" disabled={fromEnvironment.has('bucket')} /></Field>
              <Field label={t('console.r2AccessKey')}><Input value={keys.accessKeyId} onChange={(event) => setKeys({ ...keys, accessKeyId: event.target.value })} autoComplete="off" disabled={fromEnvironment.has('accessKeyId')} /></Field>
              <Field label={t('console.r2SecretKey')}><PasswordInput revealLabel={t('setup.reveal')} hideLabel={t('setup.hide')} value={keys.secretAccessKey} onChange={(event) => setKeys({ ...keys, secretAccessKey: event.target.value })} autoComplete="new-password" disabled={fromEnvironment.has('secretAccessKey')} /></Field>
              <p className="text-xs text-muted-foreground">{t('console.r2SetupBody')}</p>
            </div> : null}
          </div>
        </RadioGroup>
        {/* An account that has not enabled R2 already says so, in the row where
            it was chosen and with the way to fix it attached. Saying it again
            down here in the general failure slot is the same sentence twice. */}
        {error && !(choice === 'cloudflare' && cloudflare?.problem === 'r2_not_enabled') ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>{t('common.cancel')}</Button>
        <Button onClick={() => save()} disabled={saving || !canSave}>{t('common.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * The Cloudflare half of that question, in whatever state the sign-in is in.
 *
 * Four states and one of them - connected - carries the bucket picker, because
 * which bucket of the account is part of the same answer and not worth a
 * dialog of its own on top of this one. The buckets are asked for when this
 * first shows connected, which is the only moment the list is wanted.
 */
function CloudflareMethod({ t, status, busy, account, signInUrl, onAccountChange, onConnect, onChooseAccount, onChooseBucket, onDisconnect, onRecheckR2 }: {
  t: Translate;
  status: NonNullable<R2Config['cloudflare']>;
  busy: boolean;
  account: string;
  /**
   * The sign-in this page started but could not open a window for.
   *
   * Set only where the browser refused the window, and it turns the button
   * below into a plain link to the same address - a press the browser has
   * never been known to block.
   */
  signInUrl: string | null;
  onAccountChange: (id: string) => void;
  onConnect: () => void;
  onChooseAccount: () => Promise<void>;
  onChooseBucket: (name: string) => Promise<void>;
  onDisconnect: () => void;
  onRecheckR2: (quiet?: boolean) => Promise<void>;
}) {
  // Cloudflare's own colour, because this button hands the reader over to
  // Cloudflare and they decide whether to trust it by recognising it.
  const brand = { backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' };
  const [buckets, setBuckets] = useState<CloudflareBucketOption[] | null>(null);
  const [bucketError, setBucketError] = useState<string | null>(null);
  const connected = status.state === 'connected';
  useEffect(() => {
    if (!connected) { setBuckets(null); return undefined; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/r2/cloudflare/buckets', { credentials: 'same-origin' });
        const payload = await response.json() as { buckets?: CloudflareBucketOption[]; error?: { message?: string } };
        if (cancelled) return;
        if (!response.ok || !payload.buckets) { setBucketError(payload.error?.message ?? t('console.cfBucketsFailed')); return; }
        setBuckets(payload.buckets);
      } catch { if (!cancelled) setBucketError(t('console.cfBucketsFailed')); }
    })();
    return () => { cancelled = true; };
  }, [connected, status.bucket]);

  // The same button either way, so "press it again" means what it says.
  const connectButton = (label: string, icon: ReactNode) => (signInUrl
    ? <Button size="sm" style={brand} className="w-fit hover:opacity-90" asChild>
      <a href={signInUrl} target="_blank" rel="noopener noreferrer">{icon}{label}</a>
    </Button>
    : <Button size="sm" style={brand} className="w-fit hover:opacity-90" onClick={onConnect} disabled={busy}>{icon}{label}</Button>);

  if (status.state === 'disconnected') {
    return connectButton(t('console.cfConnect'), <CloudflareMark />);
  }
  if (status.state === 'reconnect_required') {
    return <div className="grid gap-2">
      {/* Two different reasons to sign in again, and only one of them is
          Cloudflare's. A grant that expired is a thing that happened to this
          console; an account another machine took is a thing somebody did,
          and pressing this button takes it back off them - which is worth
          saying before it is pressed rather than after. */}
      <p className="text-xs text-muted-foreground">{status.displacedBy
        ? t('console.cfDisplacedHint', { name: status.displacedBy })
        : t('console.cfReconnectHint')}</p>
      <div className="flex flex-wrap gap-2">
        {connectButton(t('console.cfReconnect'), <RefreshCw />)}
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>{t('console.cfDisconnect')}</Button>
      </div>
    </div>;
  }
  if (status.state === 'choose_account') {
    return <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{t('console.cfChooseAccount')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={account} onValueChange={onAccountChange}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {status.accounts.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => onChooseAccount()} disabled={busy || !account}>{t('console.cfUseAccount')}</Button>
        {/* Signed in, with the account still to pick - and no way back out. The
            grant exists from this point on, so the way to give it back has to
            exist from this point on too, and this is where somebody who has
            just seen that the account cannot be used needs it. Outlined, not
            ghosted: it ends a connection, and it has to read as something that
            can be pressed. */}
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>{t('console.cfDisconnect')}</Button>
      </div>
      {/* An account that has not turned R2 on fails the moment it is chosen,
          with the sign-in itself in perfect order. The way out is on Cloudflare. */}
      {status.problem === 'r2_not_enabled' ? <Alert variant="destructive"><TriangleAlert /><AlertDescription className="grid gap-2">
        <span>{t('console.cfR2NotEnabledBody')}</span>
        <R2ActivationActions t={t} onRecheck={onRecheckR2} />
      </AlertDescription></Alert> : null}
    </div>;
  }
  return <div className="grid gap-2">
    <p className="text-xs text-muted-foreground">{t('console.cfConnectedAs', { account: status.account?.name ?? '', bucket: status.bucket ?? '' })}</p>
    <div className="flex flex-wrap items-center gap-2">
      {buckets === null && !bucketError
        ? <Skeleton className="h-9 w-56" />
        : buckets?.length === 0
        ? <p className="text-xs text-muted-foreground">{t('console.cfBucketsEmpty')}</p>
        : <Select value={status.bucket ?? ''} onValueChange={(name) => { if (name !== status.bucket) void onChooseBucket(name); }} disabled={busy || buckets === null}>
          <SelectTrigger className="w-56" aria-label={t('console.cfBucketLabel')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {(buckets ?? []).map((bucket) => <SelectItem key={`${bucket.jurisdiction}/${bucket.name}`} value={bucket.name}>{bucket.name}</SelectItem>)}
          </SelectContent>
        </Select>}
      <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>{t('console.cfDisconnect')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('console.cfBucketBody')}</p>
    {bucketError ? <p className="text-xs text-destructive">{bucketError}</p> : null}
  </div>;
}

/**
 * How often changes go up, and how far back they can be brought back.
 *
 * The dialog used to ask for six numbers, three of them retention: "keep
 * recovery points", "then keep one a day", "then keep one a week". Each was
 * accurate and together they were a puzzle - nobody could say how far back
 * 48, 14 and 8 let them go without working it out. The question people have
 * is how far back, so that is what is asked, and each answer is a set of the
 * same numbers the server has always taken. The numbers are still there, under
 * "Exact numbers", and a combination that matches no answer reads as Custom.
 */
function R2ScheduleDialog({ t, open, onOpenChange, config, onSave }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; config: R2Config | null; onSave: (form: R2ScheduleForm) => Promise<string | null> }) {
  const [form, setForm] = useState<R2ScheduleForm>(() => r2ScheduleFrom(config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setForm(r2ScheduleFrom(config)); setError(null); } }, [open, config]);
  const set = (patch: Partial<R2ScheduleForm>) => setForm((current) => ({ ...current, ...patch }));
  const number = (value: string, fallback: number) => { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? parsed : fallback; };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onSave(form);
      setError(failure);
      if (!failure) onOpenChange(false);
    } finally { setBusy(false); }
  };

  const upload = uploadChoice(form.hotIntervalMinutes, form.coldIntervalHours);
  const history = historyChoice(form.keepRecent, form.keepDaily, form.keepWeekly);
  const exact: Array<{ label: string; value: number; apply: (value: number) => Partial<R2ScheduleForm>; min: number }> = [
    { label: t('console.r2HotEvery'), value: form.hotIntervalMinutes, apply: (value) => ({ hotIntervalMinutes: value }), min: 1 },
    { label: t('console.r2ColdEvery'), value: form.coldIntervalHours, apply: (value) => ({ coldIntervalHours: value }), min: 1 },
    { label: t('console.r2KeepRecent'), value: form.keepRecent, apply: (value) => ({ keepRecent: value }), min: 1 },
    { label: t('console.r2KeepDaily'), value: form.keepDaily, apply: (value) => ({ keepDaily: value }), min: 0 },
    { label: t('console.r2KeepWeekly'), value: form.keepWeekly, apply: (value) => ({ keepWeekly: value }), min: 0 },
  ];

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('console.r2ScheduleTitle')}</DialogTitle>
        <DialogDescription>{t('console.r2ScheduleBody')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <ChoiceSelect
          label={t('console.r2UploadEvery')}
          hint={t('console.r2UploadEveryHint')}
          value={upload?.id ?? CUSTOM_CHOICE}
          choices={R2_UPLOAD_CHOICES.map((choice) => ({ id: choice.id, text: t(choice.label) }))}
          customLabel={t('console.r2Custom')}
          onChange={(id) => { const choice = R2_UPLOAD_CHOICES.find((item) => item.id === id); if (choice) set({ hotIntervalMinutes: choice.hotIntervalMinutes, coldIntervalHours: choice.coldIntervalHours }); }}
        />
        <div className="grid gap-1.5">
          <ChoiceSelect
            label={t('console.r2History')}
            hint={t('console.r2HistoryHint')}
            value={history?.id ?? CUSTOM_CHOICE}
            choices={R2_HISTORY_CHOICES.map((choice) => ({ id: choice.id, text: t(choice.label) }))}
            customLabel={t('console.r2Custom')}
            onChange={(id) => { const choice = R2_HISTORY_CHOICES.find((item) => item.id === id); if (choice) set({ keepRecent: choice.keepRecent, keepDaily: choice.keepDaily, keepWeekly: choice.keepWeekly }); }}
          />
          {/* The choice above says "3 months" - this says what that means in
              the same numbers the server stores, so "Custom" reads as a
              specific set of numbers rather than an unexplained label. */}
          <p className="text-xs text-muted-foreground">{t('console.r2HistoryExplain', { recent: String(form.keepRecent), daily: String(form.keepDaily), weekly: String(form.keepWeekly) })}</p>
          {!history ? <p className="text-xs text-muted-foreground">{t('console.r2CustomHint')}</p> : null}
        </div>
        <details className="r2-advanced" open={!upload || !history}>
          <summary>{t('console.r2Advanced')}</summary>
          <div className="grid gap-4 pt-3 sm:grid-cols-2">
            {exact.map((row) => <Field key={row.label} label={row.label}>
              <Input type="number" min={row.min} value={row.value} onChange={(event) => set(row.apply(number(event.target.value, row.value)))} />
            </Field>)}
          </div>
        </details>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => save()} disabled={busy}>{t('common.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** One bucket as the server lists them for the picker. */
interface CloudflareBucketOption {
  readonly name: string;
  readonly jurisdiction: string;
}

function cloudflareErrorText(t: Translate, code: string): string {
  if (code === 'login_required') return t('console.cfErrorLoginRequired');
  if (code === 'cloudflare_state_mismatch') return t('console.cfErrorStateMismatch');
  if (code === 'cloudflare_authorization_denied') return t('console.cfErrorDenied');
  if (code === 'cloudflare_not_available') return t('console.cfErrorUnavailable');
  if (code === 'cloudflare_r2_not_enabled') return t('console.cfErrorR2NotEnabled');
  return t('console.cfErrorGeneric', { code: code || 'unknown' });
}

/**
 * What Cloudflare itself says was used, beside the manager's own count.
 *
 * The manager's count only sees its own requests. Cloudflare sees the bucket
 * from every machine and the account as a whole, which is what the free tier is
 * measured against. It is asked for when the page opens, after each backup, and
 * on request; the server keeps it for fifteen minutes in between.
 */
function CloudflareUsagePanel({ t, lastUploadAt, fallback, onRegisterRefresh }: { t: Translate; lastUploadAt: string | null; fallback: ReactNode; onRegisterRefresh: (fn: () => void) => void }) {
  const [response, setResponse] = useState<R2UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (refresh: boolean) => {
    setLoading(true);
    try {
      const reply = await apiFetch(`/api/v1/r2/usage${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin' });
      if (reply.ok) setResponse(await reply.json() as R2UsageResponse);
    } catch {
      // Kept as it was; the overflow menu's refresh item tries again.
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(false); }, [lastUploadAt]);
  // The refresh action lives in the card's one overflow menu rather than a
  // second button next to this heading; this just hands that menu a way in.
  useEffect(() => { onRegisterRefresh(() => void load(true)); });

  // Until Cloudflare has answered - and if it cannot, because the permission
  // was not granted or the query failed - the manager's own count is shown
  // rather than nothing at all.
  if (!response) return <>{fallback}</>;
  if (response.unavailable === 'analytics_not_granted') return <div className="grid gap-3">{fallback}<p className="text-xs text-muted-foreground">{t('console.cfUsageNotGranted')}</p></div>;
  const usage = response.usage;
  if (!usage) return <div className="grid gap-3">{fallback}{response.error ? <p className="text-xs text-muted-foreground">{t('console.cfUsageFailed', { error: response.error })}</p> : null}</div>;

  const bars = cloudflareBars(t, usage);
  return <div className="grid gap-3">
    <div className="flex items-center gap-2">
      <h3 className="text-sm font-medium">{t('console.cfUsageTitle')}</h3>
      {loading ? <RefreshCw className="size-3 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
    </div>
    {usage.warnings.length > 0 ? <Alert variant="destructive"><TriangleAlert /><AlertDescription>
      {usage.warnings.map((warning) => <span className="block" key={`${warning.scope}-${warning.metric}`}>{warningText(t, warning)}</span>)}
    </AlertDescription></Alert> : null}
    {/* Whole-account figures only. The bucket's own month-to-date numbers
        used to repeat here too, but the account totals are what the free
        tier is measured against, and the bucket ones just doubled the page
        without answering a different question. */}
    <span className="text-xs font-medium">{t('console.cfUsageAccount')}</span>
    {bars.map((bar) => <div className="grid gap-1" key={bar.label}>
      <span className={cn('text-xs', bar.filled >= 0.8 ? 'text-destructive' : 'text-muted-foreground')}>{bar.label}: {bar.text}</span>
      <span className="progress-track"><span className="progress-value" style={{ width: `${Math.max(1, bar.filled * 100)}%` }} /></span>
    </div>)}
    {response.error ? <p className="text-xs text-muted-foreground">{t('console.cfUsageFailed', { error: response.error })}</p> : null}
  </div>;
}

function cloudflareBars(t: Translate, usage: R2CloudflareUsage): Array<{ label: string; text: string; filled: number }> {
  const storage = usage.account.storageBytes;
  return [
    {
      label: t('console.cfStorage'),
      text: storage === null ? t('console.cfNotReported') : t('console.cfOfFree', { used: formatBytes(storage), limit: formatBytes(usage.freeTier.storageBytes) }),
      filled: ratio(storage ?? 0, usage.freeTier.storageBytes),
    },
    { label: t('console.cfClassA'), text: t('console.cfOfFree', { used: usage.account.operations.classA.toLocaleString(), limit: usage.freeTier.classA.toLocaleString() }), filled: ratio(usage.account.operations.classA, usage.freeTier.classA) },
    { label: t('console.cfClassB'), text: t('console.cfOfFree', { used: usage.account.operations.classB.toLocaleString(), limit: usage.freeTier.classB.toLocaleString() }), filled: ratio(usage.account.operations.classB, usage.freeTier.classB) },
  ];
}

function warningText(t: Translate, warning: R2UsageWarning): string {
  const metric = t(warning.metric === 'storage' ? 'console.cfStorage' : warning.metric === 'classA' ? 'console.cfClassA' : 'console.cfClassB');
  const percent = `${Math.round((warning.used / warning.limit) * 100)}%`;
  return t(warning.scope === 'account' ? 'console.cfWarningAccount' : 'console.cfWarningBucket', { metric, percent });
}

/** One plain question with a few answers, and "Custom" only when none of them fits. */
function ChoiceSelect({ label, hint, value, choices, customLabel, onChange }: { label: string; hint: string; value: string; choices: ReadonlyArray<{ id: string; text: string }>; customLabel: string; onChange: (id: string) => void }) {
  return <Field label={label} hint={hint}>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {choices.map((choice) => <SelectItem key={choice.id} value={choice.id}>{choice.text}</SelectItem>)}
        {value === CUSTOM_CHOICE ? <SelectItem value={CUSTOM_CHOICE} disabled>{customLabel}</SelectItem> : null}
      </SelectContent>
    </Select>
  </Field>;
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
    {/* Where the counts come from, which is the difference between a figure
        that resets when this machine is replaced and one that does not. */}
    <p className="text-xs text-muted-foreground">
      {config.usage.sharedRecord && config.usage.countingSince
        ? t('console.r2UsageShared', { since: new Date(config.usage.countingSince).toLocaleDateString() })
        : t('console.r2UsageNote')}
    </p>
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

/**
 * What this machine is doing, read once for everything that asks.
 *
 * The same snapshot answers three questions on the overview - how loaded the
 * machine is, how much room is left, and how large the data has grown - and
 * they are asked in three different cards. One poll serves all of them rather
 * than each card opening its own.
 */
/**
 * Three live readings of the machine, filled by the console's own poll.
 *
 * They used to be a request of their own every five seconds, made only on the
 * page that shows them - which was the right shape and still the wrong cost:
 * twelve requests a minute, four hundred and sixty bytes each, for gauges
 * nobody reads faster than that. They now ride along with the status answer,
 * which asks for them only on the page that shows them.
 *
 * Remeasuring is still a request of its own. It is somebody pressing a button
 * after deleting an archive, not a clock.
 */
function useSystemSnapshot(csrfToken: string): { snapshot: SystemSnapshot | null; accept: (snapshot: SystemSnapshot) => void; remeasure: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const remeasure = async () => {
    try {
      const response = await apiFetch('/api/v1/system/measure', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (response.ok) setSnapshot(await response.json() as SystemSnapshot);
    } catch {
      // The next poll reports the sizes whether or not this request landed.
    }
  };
  return { snapshot, accept: setSnapshot, remeasure };
}

/**
 * How hard this machine is working, and nothing about what is stored on it.
 *
 * The card used to end with two directory sizes - what the manager keeps and
 * what SillyTavern's data weighs - which put a number for the whole
 * installation directly above a number for one profile inside it, with no way
 * to tell that the second was part of the first. Both have moved to where the
 * thing they measure is managed; this card is now three live readings and a
 * core count nobody was acting on has gone with them.
 */
function SystemPanel({ t, snapshot }: { t: Translate; snapshot: SystemSnapshot | null }) {
  const rows: Array<{ key: string; label: string; value: string; ratio?: number }> = [];
  if (snapshot) {
    const { cpu, memory, storage } = snapshot;
    rows.push({
      key: 'cpu',
      label: t('system.cpu'),
      value: cpu.usagePercent === null ? '—' : `${cpu.usagePercent}%`,
      ...(cpu.usagePercent === null ? {} : { ratio: cpu.usagePercent / 100 }),
    });
    rows.push({
      key: 'memory',
      label: t('system.memory'),
      value: `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
      ratio: memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0,
    });
    if (storage.inMemory) {
      // Files are pages of the memory above, and the disk `statfs` would
      // name is the host's: room this machine does not have.
      rows.push({ key: 'disk', label: t('system.disk'), value: t('system.inMemory') });
    } else if (storage.totalBytes !== null && storage.freeBytes !== null) {
      const used = storage.totalBytes - storage.freeBytes;
      rows.push({
        key: 'disk',
        label: t('system.disk'),
        value: `${formatBytes(storage.freeBytes)} ${t('system.free')} / ${formatBytes(storage.totalBytes)}`,
        ratio: storage.totalBytes > 0 ? used / storage.totalBytes : 0,
      });
    }
  }

  return <Card data-tour="system" className="overview-pair"><PanelHeading icon={<Cpu />}>{t('system.title')}</PanelHeading><CardContent className="flex-1">
    {snapshot ? <dl className="system-list">{rows.map((row) => <div key={row.key}>
      <dt>{row.label}</dt>
      <dd>
        <span>{row.value}</span>
        {row.ratio === undefined ? null : <span className="system-track"><span className="system-value" style={{ width: `${Math.round(Math.max(0, Math.min(1, row.ratio)) * 100)}%` }} /></span>}
      </dd>
    </div>)}</dl> : <dl className="system-list" aria-busy="true">{/* The shape the readings will take, rather than the word "Loading" in
        the middle of a card that is about to be full of numbers. */}
      {['cpu', 'memory', 'disk'].map((key) => <div key={key}>
        <dt><Skeleton className="h-3 w-20" /></dt>
        <dd><Skeleton className="h-4 w-36" /></dd>
      </div>)}
    </dl>}
  </CardContent></Card>;
}

/**
 * What the providers have been asked for.
 *
 * The page opened with four tiles written at three different sizes, one of
 * which hid six more numbers behind a disclosure triangle drawn as an
 * ellipsis, and ended with two lists that were not tables: a `role="table"`
 * div, a hand-drawn bar per row, and a hard cap at eight rows with no way to
 * reach the ninth. The tiles are one shape now, the detail is behind a named
 * button rather than a triangle, and the two lists are the same table as
 * everywhere else - so they can be searched, sorted and paged through.
 */
function MetricsPage({ t }: { t: Translate }) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [days, setDays] = useState(30);
  const [refresh, setRefresh] = useState(0);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [providerQuery, setProviderQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 10, sort: 'requests', direction: 'desc' }));
  const [modelQuery, setModelQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 10, sort: 'requests', direction: 'desc' }));
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

  const labels = tableLabels(t);
  const columns: DataTableColumn<MetricsBucket>[] = [
    {
      id: 'key',
      header: t('common.name'),
      sortable: true,
      cell: (row) => <div className="grid min-w-0">
        <span className="truncate font-medium" title={row.key}>{row.key}</span>
        {row.completionSource ? <span className="truncate text-xs text-muted-foreground">{row.completionSource}</span> : null}
      </div>,
    },
    { id: 'requests', header: t('console.metricRequests'), sortable: true, align: 'end', cell: (row) => <span className="tabular-nums">{row.requests.toLocaleString()}</span> },
    { id: 'totalTokens', header: t('console.metricTokens'), sortable: true, align: 'end', showFrom: 'sm', cell: (row) => <span className="tabular-nums text-muted-foreground">{row.totalTokens.toLocaleString()}</span> },
  ];

  return <div className="grid min-w-0 gap-4">
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Tabs value={String(days)} onValueChange={(value) => { const next = Number(value); if (next !== days) { setSnapshot(null); setDays(next); } }}>
        <TabsList aria-label={t('console.metricsPeriod')}>
          {([7, 30, 90] as const).map((value) => <TabsTrigger key={value} value={String(value)}>{value} {t('console.metricsDays')}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button>
    </div>
    {!snapshot
      ? error
        ? <Card><CardContent className="px-0"><EmptyState icon={<BarChart3 />} title={t('console.metricsLoadFailed')} /></CardContent></Card>
        : <MetricsSkeleton />
      : <>
        {error ? <Alert variant="destructive"><AlertDescription>{t('console.metricsLoadFailed')}</AlertDescription></Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile icon={<BarChart3 />} label={t('console.metricRequests')} value={snapshot.totals.requests.toLocaleString()} />
          <StatTile
            icon={<Database />}
            label={t('console.metricTokens')}
            value={snapshot.totals.totalTokens.toLocaleString()}
            hint={`${metricCompact(snapshot.totals.inputTokens)} ${t('console.metricInput')} · ${metricCompact(snapshot.totals.outputTokens)} ${t('console.metricOutput')}`}
            action={<Button variant="ghost" size="icon-sm" aria-label={t('console.metricBreakdown')} onClick={() => setBreakdownOpen(true)}><Ellipsis /></Button>}
          />
          <StatTile
            icon={<Database />}
            label={t('console.metricCacheHit')}
            value={formatMetricRate(snapshot.totals.cacheHitRate)}
            {...(snapshot.totals.cacheObservedRequests > 0 ? { hint: `${snapshot.totals.cacheObservedRequests.toLocaleString()} ${t('console.metricCacheRequests')}` } : {})}
          />
          {/* How long SillyTavern was actually up, which none of the three
              beside it can say: hours that produced no request to a provider
              are as much a part of the picture as the requests are. The
              manager's own uptime and the time the console was open are
              measured too, and are in the telemetry rather than here - they
              say something about the project, not about this machine. */}
          <StatTile icon={<Play />} label={t('console.usageSillyTavern')} value={usageDuration(t, snapshot.appUsage?.totals.sillyTavernSeconds ?? 0)} />
        </div>
        <TrendChart t={t} daily={snapshot.daily} to={snapshot.range.to} days={days} />
        <div className="grid min-w-0 gap-4">
          <Card>
            <PanelHeading icon={<BarChart3 />} action={<Badge variant="outline">{snapshot.providers.length}</Badge>}>{t('console.metricProviders')}</PanelHeading>
            <CardContent>
              <DataTable rows={snapshot.providers} columns={columns} rowKey={(row) => row.key} query={providerQuery} onQueryChange={setProviderQuery} labels={labels} searchText={metricsSearchText} sortValue={metricsSortValue} pageSizes={[10, 25, 50]} empty={<EmptyState icon={<BarChart3 />} title={t('console.noMetrics')} />} />
            </CardContent>
          </Card>
          <Card>
            <PanelHeading icon={<BrainCircuit />} action={<Badge variant="outline">{snapshot.models.length}</Badge>}>{t('console.metricModels')}</PanelHeading>
            <CardContent>
              <DataTable rows={snapshot.models} columns={columns} rowKey={(row) => row.key} query={modelQuery} onQueryChange={setModelQuery} labels={labels} searchText={metricsSearchText} sortValue={metricsSortValue} pageSizes={[10, 25, 50]} empty={<EmptyState icon={<BrainCircuit />} title={t('console.noMetrics')} />} />
            </CardContent>
          </Card>
        </div>
        <TokenBreakdown t={t} open={breakdownOpen} onOpenChange={setBreakdownOpen} totals={snapshot.totals} />
      </>}
  </div>;
}

/**
 * The page, before the first answer arrives.
 *
 * A card with the word "Loading" in the middle of it tells a reader nothing
 * about what is coming and moves everything when it does. These are the
 * shapes the tiles, the chart and the tables will occupy, in their places.
 */
function MetricsSkeleton() {
  return <div className="grid min-w-0 gap-4" aria-busy="true">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((tile) => <Card key={tile} className="gap-0 py-4"><CardContent className="grid gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-28" />
      </CardContent></Card>)}
    </div>
    <Card><CardContent className="py-6"><Skeleton className="h-56 w-full" /></CardContent></Card>
    <Card><CardContent className="grid gap-3 py-6">
      {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-5 w-full" />)}
    </CardContent></Card>
  </div>;
}

/**
 * The numbers only somebody tuning a prompt cache wants.
 *
 * They used to hang off an ellipsis in the corner of a tile, in a popover that
 * closed when the pointer left it. Behind a named button they can be read at
 * leisure, and the tile above is four numbers shorter.
 */
function TokenBreakdown({ t, open, onOpenChange, totals }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; totals: MetricsSnapshot['totals'] }) {
  // Cached tokens are reported by the provider, not counted here. Nothing
  // observed means nothing to say, which is not the same as zero.
  const cached = (value: number) => totals.cacheObservedRequests === 0 ? '—' : value.toLocaleString();
  const rows: Array<{ label: string; value: string }> = [
    { label: t('console.metricInput'), value: totals.inputTokens.toLocaleString() },
    { label: t('console.metricOutput'), value: totals.outputTokens.toLocaleString() },
    { label: t('console.metricCacheRead'), value: cached(totals.cacheReadTokens) },
    { label: t('console.metricCacheWrite'), value: cached(totals.cacheWriteTokens) },
    { label: t('console.metricReasoning'), value: totals.reasoningTokens.toLocaleString() },
    { label: t('console.metricStreaming'), value: totals.streamRequests.toLocaleString() },
  ];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t('console.metricBreakdown')}</DialogTitle></DialogHeader>
      <DialogBody>
        {rows.map((row) => <DetailRow key={row.label} label={row.label}><span className="tabular-nums">{row.value}</span></DetailRow>)}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * How wide an element is right now, kept current as it changes.
 *
 * The activity chart was drawn once at 880 units and scaled to fit its card.
 * On a phone that is a scale of about 0.4, which took its ten-pixel labels
 * down to four - present, and unreadable. Drawn at the width it is shown at,
 * one unit is one pixel and a label is the size the stylesheet says.
 */
function useElementWidth<T extends HTMLElement>(fallback: number): { ref: RefObject<T | null>; width: number } {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function TrendChart({ t, daily, to, days }: { t: Translate; daily: readonly MetricsSnapshot['daily'][number][]; to: string; days: number }) {
  const [measure, setMeasure] = useState<'requests' | 'totalTokens'>('requests');
  const [selected, setSelected] = useState<string | null>(null);
  const { ref, width: measured } = useElementWidth<HTMLDivElement>(880);
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
  const width = Math.max(260, measured);
  const compact = width < 560;
  const height = compact ? 200 : 250;
  const pad = { top: 12, right: compact ? 14 : 24, bottom: 28, left: compact ? 40 : 52 };
  const plotWidth = width - pad.left - pad.right; const plotHeight = height - pad.top - pad.bottom;
  const step = plotWidth / Math.max(1, series.length - 1);
  const xFor = (index: number) => pad.left + index * step;
  const yFor = (value: number) => pad.top + plotHeight * (1 - value / scale);
  // A date roughly every 64 pixels, whatever the width - five labels across a
  // desktop card, three on a phone - and never one crowding the last.
  const labelEvery = Math.max(1, Math.ceil(64 / step));
  const labelled = (index: number) => index === 0 || index === days - 1 || (index % labelEvery === 0 && days - 1 - index >= labelEvery * 0.75 && index >= labelEvery * 0.75);
  const anchor = (index: number) => index === 0 ? 'start' : index === days - 1 ? 'end' : 'middle';
  const points = series.map((bucket, index) => `${xFor(index)},${yFor(bucket[measure])}`).join(' ');
  const selection = series.find((bucket) => bucket.key === selected) ?? series.at(-1)!;
  return <Card>
    <PanelHeading icon={<BarChart3 />} action={<Tabs value={measure} onValueChange={(value) => setMeasure(value as 'requests' | 'totalTokens')}>
      <TabsList aria-label={t('console.metricActivity')}>
        <TabsTrigger value="requests">{t('console.metricRequests')}</TabsTrigger>
        <TabsTrigger value="totalTokens">{t('console.metricTokens')}</TabsTrigger>
      </TabsList>
    </Tabs>}>{t('console.metricActivity')}</PanelHeading>
    <CardContent>
      <div ref={ref} className="min-w-0">
        <div className="trend-selection" style={{ marginLeft: pad.left }} aria-live="polite"><time dateTime={selection.key}>{new Date(selection.key).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}</time><strong>{selection[measure].toLocaleString()}</strong><span>{t(measure === 'requests' ? 'console.metricRequestsShort' : 'console.metricTokens')}</span></div>
        {daily.length === 0 ? <EmptyState icon={<BarChart3 />} title={t('console.noMetrics')} /> : <div className="metrics-chart-shell">
          <svg className="metrics-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t('console.metricActivity')}>
            {ticks.map((value) => <g key={value}><line x1={pad.left} x2={width - pad.right} y1={yFor(value)} y2={yFor(value)} className="trend-grid-line" /><text x={pad.left - 8} y={yFor(value) + 4} textAnchor="end" className="trend-axis-label">{metricCompact(value)}</text></g>)}
            <polygon points={`${pad.left},${yFor(0)} ${points} ${width - pad.right},${yFor(0)}`} className="trend-area" />
            <polyline points={points} className="trend-line trend-line-request" />
            {series.map((bucket, index) => <g key={bucket.key}>
              {bucket.key === selection.key ? <line x1={xFor(index)} x2={xFor(index)} y1={pad.top} y2={yFor(0)} className="trend-cursor" /> : null}
              {bucket[measure] > 0 ? <circle cx={xFor(index)} cy={yFor(bucket[measure])} r={compact ? 2.5 : 3} className="trend-point trend-point-request" /> : null}
              {labelled(index) ? <text x={xFor(index)} y={height - 8} textAnchor={anchor(index)} className="trend-axis-label">{bucket.key.slice(5).replace('-', '/')}</text> : null}
              <rect x={xFor(index) - step / 2} y={pad.top} width={step} height={plotHeight} fill="transparent" tabIndex={0} role="button" aria-label={`${bucket.key}: ${bucket[measure]} ${t(measure === 'requests' ? 'console.metricRequestsShort' : 'console.metricTokens')}`} onPointerEnter={() => setSelected(bucket.key)} onFocus={() => setSelected(bucket.key)} onClick={() => setSelected(bucket.key)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(bucket.key); } }} />
            </g>)}
          </svg>
        </div>}
      </div>
    </CardContent>
  </Card>;
}

function metricCompact(value: number): string { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function formatMetricRate(value: number | null): string { return value === null ? '—' : `${(value * 100).toFixed(1)}%`; }

/**
 * A span of use, in the largest unit that still says something.
 *
 * Days for a manager that has been left running, hours for one that gets
 * opened, minutes for one that was tried once. Seconds only under a minute,
 * where anything larger would round the whole reading away to zero.
 */
function usageDuration(t: Translate, seconds: number): string {
  if (seconds >= 48 * 60 * 60) return t('console.usageDays', { value: (seconds / 86_400).toFixed(1) });
  if (seconds >= 60 * 60) return t('console.usageHours', { value: (seconds / 3_600).toFixed(1) });
  if (seconds >= 60) return t('console.usageMinutes', { value: String(Math.round(seconds / 60)) });
  return t('console.usageSeconds', { value: String(Math.round(seconds)) });
}

/**
 * The two passwords' page, and SillyTavern's own settings.
 *
 * A thirty-line YAML editor used to sit open at the bottom of it. It is the
 * one control here that can stop SillyTavern from starting, and it was the
 * largest thing on the page - so it is behind a button now, where somebody who
 * wants it will still find it and nobody else has to scroll past it.
 *
 * Whether a save worked was decided by testing the message for the English
 * word "Could", which meant a Vietnamese failure was shown in the colour of a
 * note. Success and failure are separate states now, and success is a toast,
 * because saving restarts SillyTavern and redraws the page underneath it.
 */
type FlagKey = Exclude<Extract<keyof ConfigSettingsInput, string>, 'memoryCacheCapacity' | 'chatBackupCount'>;

const MEMORY_CACHE_SIZES = ['0', '50mb', '100mb', '250mb', '500mb'] as const;
const CHAT_BACKUP_COUNTS = ['5', '20', '50', '100', '200'] as const;

/**
 * The settings the console offers, lifted out of everything the file says.
 *
 * The rest of `ConfigSettings` is reported rather than editable - the port,
 * the listen address, the two password mechanisms the gateway replaces - and
 * sending any of it back would be asking the server to refuse it.
 */
function offeredSettings(settings: ConfigSettings): ConfigSettingsInput {
  return {
    lazyLoadCharacters: settings.lazyLoadCharacters,
    useDiskCache: settings.useDiskCache,
    memoryCacheCapacity: settings.memoryCacheCapacity,
    requestCompression: settings.requestCompression,
    extensions: settings.extensions,
    extensionAutoUpdate: settings.extensionAutoUpdate,
    allowKeysExposure: settings.allowKeysExposure,
    chatBackups: settings.chatBackups,
    chatBackupCount: settings.chatBackupCount,
  };
}

/** `1.19.0` is a number; `v1.19.0` is a version. */
function versionLabel(ref: string): string {
  return /^[0-9]/u.test(ref) ? `v${ref}` : ref;
}

/** `config.yaml`, or `config.yml` where that is what the version wrote. */
function configFileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? 'config.yaml';
}

/**
 * The three ports, and the one of them this page can move.
 *
 * The console's own and the gateway's are shown but not editable: they are read
 * from the environment once, at startup, and moving the port a page is served
 * on from that page takes the page down with it. Saying so on the row is worth
 * more than a control that would have to explain why it did nothing.
 *
 * SillyTavern's is checked here before it is sent, because the reader is still
 * looking at the field; the server checks it again, because a panel is not what
 * guarantees two services do not land on one port.
 */
/**
 * What the manager does with SillyTavern when it opens.
 *
 * Its own card rather than a row among SillyTavern's settings: everything
 * there is written into the installed runtime's config.yaml and belongs to the
 * version installed. This belongs to the manager and outlives every version it
 * installs - which is also why it is not in the file the Edit button opens.
 */
function StartupCard({ t, startup, saver, onSetAutoStart, onSetSaver }: { t: Translate; startup: StartupSettings | null; saver: SaverState | null; onSetAutoStart: (enabled: boolean) => Promise<string | null>; onSetSaver: (enabled: boolean) => Promise<string | null> }) {
  // What the switch shows while the answer is in flight, so it moves under the
  // press rather than a second later.
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const checked = pending ?? startup?.autoStartSillyTavern ?? null;
  const save = async (next: boolean) => {
    setPending(next); setBusy(true);
    try {
      const failure = await onSetAutoStart(next);
      if (failure) { toast({ title: failure, tone: 'destructive' }); return; }
      // Not `configSaved`: nothing was written into SillyTavern's own config and
      // nothing restarted. What changed is what the next start will do.
      toast({ title: t('console.startupSaved'), tone: 'success' });
    } finally { setPending(null); setBusy(false); }
  };
  return <Card>
    <PanelHeading icon={<Play />}>{t('console.startupTitle')}</PanelHeading>
    <CardContent>
      <DetailRow label={t('console.autoStartSillyTavern')} hint={t('console.autoStartSillyTavernHint')}>
        {checked === null
          ? <Skeleton className="h-5 w-9" />
          : <Switch checked={checked} disabled={busy} onCheckedChange={(next) => void save(next)} aria-label={t('console.autoStartSillyTavern')} />}
      </DetailRow>
      <SaverRow t={t} saver={saver} onSetSaver={onSetSaver} />
    </CardContent>
  </Card>;
}

/**
 * Saver mode, beside the other thing the manager decides on its way up.
 *
 * The hint says where the answer came from, because two of the three are not
 * this switch: STM_SAVER, which the switch cannot move, and the machine -
 * files kept in memory, or a disk nearly full - which decided it before
 * anybody was asked.
 */
function SaverRow({ t, saver, onSetSaver }: { t: Translate; saver: SaverState | null; onSetSaver: (enabled: boolean) => Promise<string | null> }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const checked = pending ?? saver?.enabled ?? null;
  const save = async (next: boolean) => {
    setPending(next); setBusy(true);
    try {
      const failure = await onSetSaver(next);
      if (failure) { toast({ title: failure, tone: 'destructive' }); return; }
      toast({ title: t(next ? 'console.saverTurnedOn' : 'console.saverTurnedOff'), tone: 'success' });
    } finally { setPending(null); setBusy(false); }
  };
  const gibibytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  const reason = saver?.source === 'machine' && saver.enabled ? saver.reason : null;
  const source = saver?.source === 'environment'
    ? t('console.saverFromEnvironment')
    : reason === 'inMemory'
      ? t('console.saverInMemory', { memory: gibibytes(saver?.memoryBytes ?? 0) })
      : reason === 'lowDisk'
        ? t('console.saverLowDisk', { disk: gibibytes(saver?.diskBytes ?? 0) })
        : null;
  return <DetailRow label={t('console.saverMode')} hint={source ? `${t('console.saverHint')} ${source}` : t('console.saverHint')}>
    {checked === null
      ? <Skeleton className="h-5 w-9" />
      : <Switch checked={checked} disabled={busy || saver?.source === 'environment'} onCheckedChange={(next) => void save(next)} aria-label={t('console.saverMode')} />}
  </DetailRow>;
}

/** The intervals offered; anything else somebody sets is shown as it is. */
const KEEP_ONLINE_MINUTES = [5, 10, 15, 30, 60] as const;

/**
 * Keeping the manager online where being unused is treated as being finished.
 *
 * On somebody's own computer this does nothing and the card says so: the
 * program runs until it is stopped, and there is no address of its own to
 * keep. It earns its place where a battery saver or the machine underneath can
 * shut the manager down once nothing has used it for a while, and SillyTavern
 * goes with it, mid-sentence, with nothing the reader can do from where they
 * are.
 *
 * What it reports is the address, because that is the part worth checking: a
 * switch that is on over a manager with nowhere to be reached is doing
 * nothing, and saying "on" over that would be a lie of omission.
 */
function KeepOnlineCard({ t, locale, online, onSetKeepOnline }: {
  t: Translate;
  locale: LocaleCode;
  online: OnlineState | null;
  onSetKeepOnline: (enabled: boolean, minutes: number) => Promise<string | null>;
}) {
  // What the controls show while the answer is in flight, so they move under
  // the press rather than a second later.
  const [pending, setPending] = useState<{ enabled: boolean; minutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const checked = pending?.enabled ?? online?.enabled ?? null;
  const minutes = pending?.minutes ?? online?.minutes ?? null;
  const save = async (enabled: boolean, next: number) => {
    setPending({ enabled, minutes: next }); setBusy(true);
    try {
      const failure = await onSetKeepOnline(enabled, next);
      if (failure) { toast({ title: failure, tone: 'destructive' }); return; }
      toast({ title: t('console.keepOnlineSaved'), tone: 'success' });
    } finally { setPending(null); setBusy(false); }
  };
  // The address as a reader recognises it: no scheme, and the middle taken out
  // of a long hostname. `shortenHost` wants a bare host - handed a whole URL it
  // cut the scheme in half and left `http....0.1:7876`.
  const address = shortenHost(bareHost(online?.address ?? ''));
  const note = !online || !online.enabled ? null
    : online.status === 'unreachable' ? t('console.keepOnlineUnreachable', { address })
      // Loopback, because nothing from outside has reached this manager yet.
      // Worth saying rather than reporting an address as held without
      // explaining why it is this one.
      : online.source === 'local' ? t('console.keepOnlineLocal', { address })
        : t('console.keepOnlineHolding', { address });
  // Whatever is stored belongs in the list even when it is not one of the
  // offered values, so a console cannot quietly change a choice by showing a
  // different one next to it.
  const offered = minutes !== null && !KEEP_ONLINE_MINUTES.includes(minutes as typeof KEEP_ONLINE_MINUTES[number])
    ? [...KEEP_ONLINE_MINUTES, minutes].sort((left, right) => left - right)
    : [...KEEP_ONLINE_MINUTES];
  return <Card>
    <PanelHeading icon={<Globe2 />}>{t('console.keepOnlineTitle')}</PanelHeading>
    <CardContent className="grid gap-3">
      <DetailRow label={t('console.keepOnline')} hint={t('console.keepOnlineHint')}>
        {checked === null
          ? <Skeleton className="h-5 w-9" />
          : <Switch checked={checked} disabled={busy} onCheckedChange={(next) => void save(next, minutes ?? 15)} aria-label={t('console.keepOnline')} />}
      </DetailRow>
      {checked && minutes !== null
        ? <DetailRow label={t('console.keepOnlineEvery')} hint={t('console.keepOnlineEveryHint')}>
          <Select value={minutes.toString(10)} disabled={busy} onValueChange={(next) => void save(true, Number(next))}>
            <SelectTrigger className="w-36" aria-label={t('console.keepOnlineEvery')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {offered.map((value) => (
                <SelectItem key={value} value={value.toString(10)}>{t('console.keepOnlineMinutes', { count: value.toString(10) })}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DetailRow>
        : null}
      {note
        ? <p className={online?.status === 'unreachable' ? 'install-error' : 'text-xs text-muted-foreground'}>
          {note}
          {online?.lastAt
            ? ` ${t('console.keepOnlineLast', { when: new Date(online.lastAt).toLocaleTimeString(locale === 'vi' ? 'vi-VN' : 'en-GB') })}`
            : ''}
        </p>
        : null}
    </CardContent>
  </Card>;
}

function PortsCard({ t, ports, process, busy, onPortChange }: { t: Translate; ports: PortSettings | null; process: ProcessState; busy: boolean; onPortChange: (port: number) => Promise<string | null> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputId = useId();
  // Reset when the server's answer changes, so a half-typed number is not left
  // sitting over a port that has since moved.
  useEffect(() => { if (ports) { setValue(ports.port.toString(10)); setError(null); } }, [ports]);
  if (!ports) return null;

  const typed = Number(value.trim());
  const refusal = portRefusal(value, ports.reserved);
  const failure = refusal ? t(refusal.key, refusal.params) : null;
  const unchanged = refusal === null && typed === ports.port;
  const running = process.status === 'running';

  const save = async () => {
    setSaving(true); setError(null);
    try {
      setError(await onPortChange(typed));
    } finally { setSaving(false); }
  };

  return <Card>
    <PanelHeading icon={<Globe2 />}>{t('console.portsTitle')}</PanelHeading>
    <CardContent>
      <div>
        <DetailRow label={<Label htmlFor={inputId}>{t('console.sillyTavernPort')}</Label>} hint={t('console.sillyTavernPortHint')}>
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              className="w-28"
              inputMode="numeric"
              autoComplete="off"
              value={value}
              disabled={busy || saving}
              aria-invalid={failure !== null}
              onChange={(event) => { setValue(event.target.value); setError(null); }}
            />
            <Button size="sm" disabled={busy || unchanged || failure !== null} loading={saving} onClick={() => setConfirmOpen(true)}>
              {t('common.save')}
            </Button>
          </div>
        </DetailRow>
        <DetailRow label={t('console.managerPort')} hint={t('console.managerPortHint')}>
          <code className="font-mono text-sm text-muted-foreground">{ports.reserved.manager}</code>
        </DetailRow>
        <DetailRow label={t('console.accessPort')} hint={t('console.accessPortHint')}>
          <code className="font-mono text-sm text-muted-foreground">{ports.reserved.access}</code>
        </DetailRow>
      </div>
      {failure ?? error ? <Alert variant="destructive" className="mt-4"><AlertDescription>{failure ?? error}</AlertDescription></Alert> : null}
    </CardContent>
    <ConfirmDialog
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      tone="default"
      title={t('console.portChangeTitle')}
      description={running ? t('console.portChangeBodyRunning', { port: typed }) : t('console.portChangeBody', { port: typed })}
      confirmLabel={t('common.save')}
      cancelLabel={t('common.cancel')}
      onConfirm={save}
    />
  </Card>;
}

/** A name over a run of rows, so one long list reads as three short ones. */
function SettingsGroup({ icon, title }: { icon: ReactNode; title: string }) {
  return <div className="flex items-center gap-2 border-t pt-4 pb-2 text-sm font-medium first:border-t-0 first:pt-0 [&_svg]:size-4 [&_svg]:text-muted-foreground">
    {icon}{title}
  </div>;
}

/**
 * A refusal the console can act on, rather than only print.
 *
 * Most failures are a sentence and nothing more. A few name a thing the reader
 * is one dialog away from fixing, and for those the code has to survive the
 * trip from the server to the card that knows what to do about it.
 */
interface ActionFailure {
  readonly code: string | null;
  readonly text: string;
}

function ConfigPage({ t, locale, config, security, ports, managerTunnel, process, catalog, startup, saver, online, onSetAutoStart, onSetSaver, onSetKeepOnline, onSetManagerTunnel, onPortChange, onConfigUpdate, onConfigReset, onChangeManagerPassword, onSetPassword, onSignOut, onSignOutDevices, onEraseEverything }: { t: Translate; locale: LocaleCode; config: ConfigDocument | null; security: AccessGatewayState; ports: PortSettings | null; managerTunnel: TunnelState; process: ProcessState; catalog: Record<string, unknown>; startup: StartupSettings | null; saver: SaverState | null; online: OnlineState | null; onSetAutoStart: (enabled: boolean) => Promise<string | null>; onSetSaver: (enabled: boolean) => Promise<string | null>; onSetKeepOnline: (enabled: boolean, minutes: number) => Promise<string | null>; onSetManagerTunnel: (on: boolean) => Promise<ActionFailure | null>; onPortChange: (port: number) => Promise<string | null>; onConfigUpdate: (input: ConfigUpdateInput) => Promise<string | null>; onConfigReset: () => Promise<string | null>; onChangeManagerPassword: (password: string, confirmPassword: string) => Promise<string | null>; onSetPassword: (password: string, confirmPassword: string) => Promise<string | null>; onSignOut: () => Promise<void>; onSignOutDevices: () => Promise<string | null>; onEraseEverything: (password: string) => Promise<string | null> }) {
  const [form, setForm] = useState<ConfigSettingsInput>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerPasswordOpen, setManagerPasswordOpen] = useState(false);
  const [sillyPasswordOpen, setSillyPasswordOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [signOutDevicesOpen, setSignOutDevicesOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [managerTunnelBusy, setManagerTunnelBusy] = useState(false);
  const [managerTunnelError, setManagerTunnelError] = useState<string | null>(null);
  const [managerTunnelClosing, setManagerTunnelClosing] = useState(false);
  // Whether the password form on screen was opened by the link switch, which
  // decides both what it says and what happens when it succeeds.
  const [managerPasswordFirst, setManagerPasswordFirst] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocumentId>('terms');
  const { toast } = useToast();
  // What the switch says, which is what was asked for rather than whether
  // cloudflared has finished connecting - the same reading the sharing card
  // uses, for the same reason.
  const managerTunnelWanted = managerTunnel.mode !== 'off';
  /*
   * The address to show for the console's own link.
   *
   * The Worker's, when Cloudflare is signed in: it is the same address every
   * time, which is the only kind worth writing down or putting on a phone. The
   * tunnel's own is shown underneath it rather than instead of it, because it
   * is what the traffic really goes through and it changes on every restart.
   *
   * Nothing at all while that Worker is being deployed. This row is where the
   * console's address is copied from and sent to a phone, and the address it
   * would have shown in those few seconds is one that is about to change.
   */
  const managerTunnelLink = publicAddress(managerTunnel);
  const [managerQrOpen, setManagerQrOpen] = useState(false);
  const applyManagerTunnel = async (on: boolean) => {
    setManagerTunnelBusy(true); setManagerTunnelError(null);
    try {
      const failure = await onSetManagerTunnel(on);
      /*
       * The console has no password yet, so the link will not open.
       *
       * Saying so and stopping there left a switch that would not move and a
       * line of English underneath it pointing at a row further up the same
       * card - which the reader then had to recognise as the thing to do
       * next. The press was a request to open the link; the password is what
       * that request needs, so the form that sets one opens, and the link
       * opens behind it the moment it is saved.
       */
      if (failure?.code === 'manager_password_required') {
        setManagerPasswordFirst(true);
        setManagerPasswordOpen(true);
        return;
      }
      setManagerTunnelError(failure?.text ?? null);
      if (!failure) toast({ title: on ? t('console.managerTunnelOnDone') : t('console.managerTunnelOffDone'), tone: 'success' });
    } finally { setManagerTunnelBusy(false); }
  };
  useEffect(() => {
    if (!config) return;
    setForm(offeredSettings(config.settings));
  }, [config]);
  const save = async (input: ConfigUpdateInput): Promise<string | null> => {
    setBusy(true); setError(null);
    try {
      const failure = await onConfigUpdate(input);
      setError(failure);
      if (!failure) toast({ title: t('console.configSaved'), tone: 'success' });
      return failure;
    } finally { setBusy(false); }
  };
  const restoreDefaults = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onConfigReset();
      setError(failure);
      if (!failure) toast({ title: t('console.restoreDefaultsDone'), tone: 'success' });
    } finally { setBusy(false); }
  };
  const saveManagerPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const failure = await onChangeManagerPassword(password, confirmPassword);
    if (failure) return failure;
    toast({ title: t('console.managerPasswordSaved'), tone: 'success' });
    // Set because the link asked for it, so finish what the switch started.
    if (managerPasswordFirst) { setManagerPasswordFirst(false); void applyManagerTunnel(true); }
    return null;
  };
  const set = <K extends keyof ConfigSettingsInput>(key: K, value: ConfigSettingsInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const flag = (key: FlagKey, options: { readonly disabled?: boolean } = {}) =>
    <DetailRow key={key} label={t(`console.settings.${key}`)} hint={t(`console.settings.${key}Hint`)} className={options.disabled ? 'opacity-55' : ''}>
      <Switch
        checked={form[key] === true}
        onCheckedChange={(value) => set(key, value)}
        disabled={options.disabled ?? false}
        aria-label={t(`console.settings.${key}`)}
      />
    </DetailRow>;
  const choice = (key: 'memoryCacheCapacity' | 'chatBackupCount', values: readonly string[], options: { readonly disabled?: boolean } = {}) =>
    <DetailRow label={t(`console.settings.${key}`)} hint={t(`console.settings.${key}Hint`)} className={options.disabled ? 'opacity-55' : ''}>
      <Select
        value={String(form[key] ?? '')}
        onValueChange={(value) => set(key, (key === 'chatBackupCount' ? Number(value) : value) as never)}
        disabled={options.disabled ?? false}
      >
        <SelectTrigger size="sm" className="w-32" aria-label={t(`console.settings.${key}`)}><SelectValue /></SelectTrigger>
        <SelectContent>
          {values.map((value) => <SelectItem key={value} value={value}>{value === '0' ? t('console.settings.cacheOff') : value}</SelectItem>)}
        </SelectContent>
      </Select>
    </DetailRow>;

  /*
   * One card for both doors.
   *
   * It is not "Passwords": half of what it holds is signing out, and the two
   * belong together anyway - the reason to change a credential and the reason
   * to end the sessions opened with it are usually the same reason. Each row
   * is one door, with the two things that can be done to it.
   *
   * The labels only appear from `sm` up. On a phone the row has a name, and a
   * pencil next to a name has never needed the word "edit" under it.
   */
  /*
   * The visible word is the short one; the whole sentence stays as the
   * accessible name and the tooltip. Two rows each carrying "Đổi mật khẩu" and
   * "Đổi mã PIN" spelt out is the same verb four times on one card, and the
   * row already says which door it is about. Signing out is the destructive
   * one of the pair, and is coloured as such so the two are not one row of
   * identical grey buttons.
   */
  const rowAction = (icon: ReactNode, label: string, full: string, onClick: () => void, options: { readonly variant?: 'outline' | 'destructive'; readonly disabled?: boolean } = {}) =>
    <Button variant={options.variant ?? 'outline'} size="sm" disabled={options.disabled ?? false} aria-label={full} title={full} onClick={onClick}>
      {icon}<span className="hidden sm:inline">{label}</span>
    </Button>;

  return <div className="grid min-w-0 gap-4">
    <Card>
      <PanelHeading icon={<ShieldCheck />}>{t('console.securityTitle')}</PanelHeading>
      <CardContent>
        <div>
          <DetailRow label={t('console.managerPasswordTitle')} hint={t('console.managerPasswordHint')}>
            <div className="flex items-center gap-1">
              {rowAction(<Pencil />, t('common.edit'), t('console.changeManagerPassword'), () => setManagerPasswordOpen(true), { variant: 'outline' })}
              {rowAction(<LogOut />, t('console.signOut'), t('console.signOutManager'), () => void onSignOut(), { variant: 'destructive' })}
            </div>
          </DetailRow>
          <DetailRow
            label={<span className="flex flex-wrap items-center gap-2">{t('console.passwordSettings')}{security.passwordConfigured ? null : <Badge variant="outline">{t('console.passwordNotSetYet')}</Badge>}</span>}
            hint={t('console.sillyPasswordHint')}
          >
            <div className="flex items-center gap-1">
              {rowAction(<Pencil />, security.passwordConfigured ? t('common.edit') : t('console.setPasscode'), security.passwordConfigured ? t('console.changeSillyPassword') : t('console.setSillyPassword'), () => setSillyPasswordOpen(true), { variant: 'outline' })}
              {rowAction(<LogOut />, t('console.signOut'), security.sessions > 0 ? t('console.signOutDevices') : t('console.signOutDevicesNone'), () => setSignOutDevicesOpen(true), { variant: 'destructive', disabled: security.sessions === 0 })}
            </div>
          </DetailRow>
          {/* Here rather than on the sharing card: that card is about letting
              people into SillyTavern, and this is about letting them as far as
              the console - which is the side that installs software and holds
              the Cloudflare tokens. It belongs next to the password that is the
              only thing guarding it. */}
          {/* The address in full, and clickable, rather than a shortened
              fragment beside a Copy button. What somebody wants from this row
              is to be at that page, or to send it to a phone - and a link they
              can press does the first and lets them copy the second for
              themselves. The button beside it opens the same address, for a
              reader whose eye goes to the buttons rather than to the text. */}
          <DetailRow
            label={t('console.managerTunnel')}
            hint={managerTunnelLink
              ? <a className="break-all font-mono underline underline-offset-4" href={managerTunnelLink} target="_blank" rel="noopener noreferrer">{managerTunnelLink}</a>
              // The switch is on and there is no address yet: cloudflared is
              // still connecting, or the fixed address in front of it is still
              // being deployed. Either way it is coming, which is a different
              // thing to say than what this row says when the switch is off.
              : managerTunnelWanted ? <span className="thinking">{t('console.addressComing')}</span>
              : t('console.managerTunnelHint')}
          >
            <div className="flex items-center gap-1">
              {managerTunnelLink
                ? <>
                  {/* The console's own link onto a phone, the same way
                      SillyTavern's addresses are offered. */}
                  <Button variant="outline" size="sm" aria-label={t('console.shareAddress') + ' · ' + t('console.managerTunnel')} title={t('console.shareAddress')} onClick={() => setManagerQrOpen(true)}><QrCodeIcon /></Button>
                  <Button variant="outline" size="sm" aria-label={t('console.openInTab')} title={t('console.openInTab')} asChild>
                    <a href={managerTunnelLink} target="_blank" rel="noopener noreferrer"><ArrowUpRight /><span className="hidden sm:inline">{t('console.openInTab')}</span></a>
                  </Button>
                  <ShareDialog t={t} open={managerQrOpen} onOpenChange={setManagerQrOpen} label={t('console.managerTunnel')} links={[managerTunnelLink]} description={t('console.scanToOpenManager')} />
                </>
                : null}
              <Switch
                checked={managerTunnelWanted}
                disabled={managerTunnelBusy}
                onCheckedChange={(next) => { if (next) void applyManagerTunnel(true); else setManagerTunnelClosing(true); }}
                aria-label={t('console.managerTunnel')}
              />
            </div>
          </DetailRow>
        </div>
        {managerTunnelError ? <Alert variant="destructive" className="mt-4"><AlertDescription>{managerTunnelError}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
    <ConfirmDialog
      open={signOutDevicesOpen}
      onOpenChange={setSignOutDevicesOpen}
      title={t('console.signOutDevicesTitle')}
      description={t('console.signOutDevicesBody', { count: security.sessions })}
      confirmLabel={t('console.signOutDevices')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => { await onSignOutDevices(); }}
    />
    <ConfirmDialog
      open={managerTunnelClosing}
      onOpenChange={(open) => { if (!open) setManagerTunnelClosing(false); }}
      title={t('console.managerTunnelOffConfirm')}
      // Closing the link a reader arrived through takes their own page with
      // it, which is worth saying before they press the button rather than
      // leaving them to work out why the console stopped answering.
      description={managerTunnelLink && window.location.origin === managerTunnelLink.replace(/\/$/u, '')
        ? t('console.managerTunnelOffConfirmBodyHere')
        : t('console.managerTunnelOffConfirmBody')}
      confirmLabel={t('common.turnOff')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => applyManagerTunnel(false)}
    />
    <StartupCard t={t} startup={startup} saver={saver} onSetAutoStart={onSetAutoStart} onSetSaver={onSetSaver} />
    {/* Under what the manager does when it opens, because this is what it
        does for the rest of the time it is open. */}
    <KeepOnlineCard t={t} locale={locale} online={online} onSetKeepOnline={onSetKeepOnline} />
    <PortsCard t={t} ports={ports} process={process} busy={busy} onPortChange={onPortChange} />
    {/* One form, two errands. Opened from the row above it changes a password
        that exists; opened by the link switch it sets the first one there has
        ever been, and says why it is being asked for. */}
    <PasswordDialog
      t={t}
      open={managerPasswordOpen}
      onOpenChange={(open) => { setManagerPasswordOpen(open); if (!open) setManagerPasswordFirst(false); }}
      title={managerPasswordFirst ? t('console.managerPasswordSetTitle') : t('console.managerPasswordTitle')}
      description={managerPasswordFirst ? t('console.managerTunnelNeedsPassword') : t('console.managerPasswordHint')}
      note={managerPasswordFirst ? null : t('console.passwordChangeSignsOut')}
      minLength={MIN_MANAGER_PASSWORD}
      hint={t('console.managerPasswordMin')}
      submitLabel={managerPasswordFirst ? t('console.managerPasswordSet') : t('console.changePassword')}
      onSubmit={saveManagerPassword}
    />
    <PasscodeDialog t={t} open={sillyPasswordOpen} onOpenChange={setSillyPasswordOpen} note={security.passwordConfigured ? t('console.passwordChangeSignsOut') : null} onSubmit={onSetPassword} />
    {!config
      ? <Card><CardContent className="px-0"><EmptyState icon={<Settings2 />} title={t('console.noConfiguration')} /></CardContent></Card>
      : <>
        <Card>
          <PanelHeading icon={<Settings2 />} action={<Badge variant="outline">{versionLabel(config.runtimeRef)}</Badge>}>{t('console.configTitle')}</PanelHeading>
          <CardContent className="grid gap-5">
            <div>
              <SettingsGroup icon={<Gauge />} title={t('console.performanceTitle')} />
              {flag('lazyLoadCharacters')}
              {flag('useDiskCache')}
              {choice('memoryCacheCapacity', MEMORY_CACHE_SIZES)}
              {flag('requestCompression')}
            </div>
            <div>
              <SettingsGroup icon={<Blocks />} title={t('console.extensionsTitle')} />
              {flag('extensions')}
              {flag('extensionAutoUpdate', { disabled: form.extensions !== true })}
            </div>
            <div>
              <SettingsGroup icon={<KeyRound />} title={t('console.apiKeysTitle')} />
              {flag('allowKeysExposure')}
            </div>
            <div>
              <SettingsGroup icon={<History />} title={t('console.chatBackupsTitle')} />
              {flag('chatBackups')}
              {choice('chatBackupCount', CHAT_BACKUP_COUNTS, { disabled: form.chatBackups !== true })}
            </div>
            {/* Still in this card - every switch above is a line in this
                file - but set into a block of its own, because editing the
                file by hand is a different act from flipping a switch and
                should not read as the next row down. */}
            <div className="mt-2 grid gap-3 rounded-xl border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="flex items-center gap-2 text-sm font-medium"><FileCode2 className="size-4 text-muted-foreground" />{t('console.configFileTitle')}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><TriangleAlert className="size-3.5" />{t('console.configFileCaution')}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t('console.configFileHint')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="mr-auto font-mono text-sm">{configFileName(config.path)}</code>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setResetOpen(true)}><RotateCcw />{t('console.restoreDefaults')}</Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setYamlOpen(true)}><Pencil />{t('common.edit')}</Button>
              </div>
            </div>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {/* Saving stops SillyTavern, writes the file and starts it again,
                which takes as long as a start does. The dialog is gone by
                then, so the progress is here, step by step. */}
            {busy ? <div className="grid gap-2 rounded-lg border bg-muted/40 p-3" role="status">
              <TaskLine task={t('console.taskSettings')} step={(process.status === 'starting' || process.status === 'stopping') && process.stepCode ? translateStep('', catalog, process.stepCode, process.stepParams) : t('console.settingsWriting')} />
              <TaskBar />
            </div> : null}
          </CardContent>
          <CardFooter className="justify-end">
            <Button onClick={() => setSaveOpen(true)} loading={busy}>{t('console.saveChanges')}</Button>
          </CardFooter>
        </Card>
        <ConfirmDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          tone="default"
          title={t('console.saveChangesTitle')}
          description={t('console.saveChangesBody')}
          confirmLabel={t('console.saveChanges')}
          cancelLabel={t('common.cancel')}
          onConfirm={async () => { await save({ settings: form }); }}
        />
        <ConfirmDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          title={t('console.restoreDefaultsTitle')}
          description={t('console.restoreDefaultsBody')}
          confirmLabel={t('console.restoreDefaults')}
          cancelLabel={t('common.cancel')}
          onConfirm={restoreDefaults}
        />
      </>}
    {config ? <YamlDialog t={t} open={yamlOpen} onOpenChange={setYamlOpen} initial={config.rawYaml} busy={busy} onApply={(rawYaml) => save({ rawYaml })} /> : null}
    <StartOverCard t={t} onErase={onEraseEverything} />
    <AboutPanel t={t} locale={locale} onOpenLegal={(id) => { setLegalDocument(id); setLegalOpen(true); }} />
    <LegalDialog
      t={t}
      locale={locale}
      open={legalOpen}
      onOpenChange={setLegalOpen}
      document={legalDocument}
      onDocumentChange={setLegalDocument}
    />
  </div>;
}

/** Seconds the confirm button stays out of reach, so the warning is read rather than clicked past. */
const RESET_COUNTDOWN_SECONDS = 10;

/**
 * The one button on this page that takes something away for good.
 *
 * Last on the settings page and inside a border of its own, because that is
 * where a reader who is not looking for it will not find it: everything above
 * changes how the manager behaves, and this ends the manager's whole history on
 * the machine. It is the answer to an installation that has gone wrong in a way
 * nobody wants to unpick - a half-restored profile, a version that will not
 * start, credentials from an account that is not theirs any more.
 */
function StartOverCard({ t, onErase }: { t: Translate; onErase: (password: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  return <>
    <Card className="border-destructive/35">
      <PanelHeading icon={<TriangleAlert className="text-destructive" />}>{t('console.resetTitle')}</PanelHeading>
      <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="min-w-[14rem] flex-1 text-sm text-muted-foreground">{t('console.resetHint')}</p>
        <Button variant="destructive" onClick={() => setOpen(true)}><Trash2 />{t('console.resetAction')}</Button>
      </CardContent>
    </Card>
    <StartOverDialog t={t} open={open} onOpenChange={setOpen} onErase={onErase} />
  </>;
}

/**
 * Ask twice over: wait, then type the password.
 *
 * The countdown is not a delay for its own sake. The list above it is the only
 * place anybody is told what "everything" means here, and a destructive button
 * that is live the moment a dialog opens is one somebody presses while still
 * reading the first line of it. The password is the second half: it is proof
 * that the person at the keyboard is the one who set this manager up, which a
 * console left signed in on a desk is not.
 */
function StartOverDialog({ t, open, onOpenChange, onErase }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; onErase: (password: string) => Promise<string | null> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(RESET_COUNTDOWN_SECONDS);

  // Restarted on every open, so a dialog dismissed and opened again is a fresh
  // pause rather than a button that is already live.
  useEffect(() => {
    if (!open) return undefined;
    setPassword(''); setError(null); setRemaining(RESET_COUNTDOWN_SECONDS);
    const timer = window.setInterval(() => setRemaining((value) => (value <= 1 ? 0 : value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  const ready = remaining === 0 && password.length > 0 && !busy;
  const erase = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onErase(password);
      setError(failure);
      // Left open on success: the page is about to reload itself, and a dialog
      // that closed first would leave a console behind that no longer works.
      if (!failure) return;
    } finally { setBusy(false); }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t('console.resetDialogTitle')}</DialogTitle>
        <DialogDescription>{t('console.resetDialogBody')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <Alert variant="destructive"><TriangleAlert /><AlertDescription>{t('console.resetKeeps')}</AlertDescription></Alert>
        <Field label={t('console.resetPasswordLabel')} hint={t('console.resetPasswordHint')}>
          <PasswordInput
            revealLabel={t('setup.reveal')}
            hideLabel={t('setup.hide')}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </Field>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="destructive" onClick={() => erase()} disabled={!ready} loading={busy}>
          <Trash2 />
          {busy ? t('console.resetRunning') : remaining > 0 ? t('console.resetCountdown', { seconds: remaining }) : t('console.resetAction')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * What this is, which version, and where it came from.
 *
 * Every open-source application answers these three questions somewhere, and
 * this is the page people already come to when they want to know what their
 * copy is doing. It is also the only place after the first run where the terms
 * can be read again, which is the point of having asked somebody to accept
 * them: an agreement you cannot reread is not one you can hold to.
 */
function AboutPanel({ t, locale, onOpenLegal }: { t: Translate; locale: LocaleCode; onOpenLegal: (document: LegalDocumentId) => void }) {
  const bundle = legalBundle(locale);
  const links = [
    { href: LEGAL_REVISION.repository, icon: <GithubMark className="size-4" />, label: t('console.aboutSource') },
    { href: LEGAL_REVISION.site, icon: <Globe2 />, label: t('console.aboutSite') },
    { href: LEGAL_REVISION.issues, icon: <Bug />, label: t('console.aboutIssues') },
  ];
  return <Card>
    <PanelHeading icon={<Scale />} action={<Badge variant="outline">v{__STM_VERSION__}</Badge>}>{t('console.aboutTitle')}</PanelHeading>
    <CardContent className="grid gap-4">
      <div className="about-lockup">
        <BrandMark size={44} />
        <div className="grid gap-1">
          <span className="text-sm font-semibold">SillyTavern Manager</span>
          <p className="text-xs text-muted-foreground">{t('console.aboutBody')}</p>
        </div>
      </div>
      <div className="about-links">
        {links.map(({ href, icon, label }) => (
          <a key={href} href={href} target="_blank" rel="noreferrer noopener">{icon}<span>{label}</span><ArrowUpRight className="size-3.5 opacity-60" /></a>
        ))}
      </div>
      <div className="about-documents">
        {bundle.documents.map((document) => (
          <Button key={document.id} variant="outline" size="sm" onClick={() => onOpenLegal(document.id)}>{document.short}</Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('console.aboutLicence')}</p>
    </CardContent>
  </Card>;
}

/** SillyTavern's own configuration file, for whoever wants to edit it directly. */
function YamlDialog({ t, open, onOpenChange, initial, busy, onApply }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; initial: string; busy: boolean; onApply: (rawYaml: string) => Promise<string | null> }) {
  const [rawYaml, setRawYaml] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Opening reloads the file as it is on disk, so an edit abandoned last time
  // is not silently re-applied over a change made since.
  useEffect(() => { if (open) { setRawYaml(initial); setError(null); } }, [open, initial]);

  const apply = async () => {
    const failure = await onApply(rawYaml);
    setError(failure);
    if (!failure) onOpenChange(false);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle className="font-mono">{t('console.configFile')}</DialogTitle>
        <DialogDescription>{t('console.rawYamlHint')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-3">
        <textarea className="config-editor" value={rawYaml} onChange={(event) => setRawYaml(event.target.value)} spellCheck={false} aria-label={t('console.configFile')} />
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => apply()} disabled={busy}>{t('console.applyYaml')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ResourcePanel({ page, t }: { page: Exclude<PageId, 'overview' | 'data'>; t: Translate }) {
  const emptyMessage = { metrics: 'console.noMetrics', config: 'console.noConfiguration' } as const;
  return <Card className="resource-panel"><CardContent className="resource-empty"><p>{t(emptyMessage[page])}</p></CardContent></Card>;
}
