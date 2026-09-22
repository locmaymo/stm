import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { extname, join, relative, resolve, sep } from 'node:path';
import { applyQuery, backupSearchText, backupSortValue, installationSearchText, installationSortValue, pageInfo, parseTableQuery, snapshotSearchText, snapshotSortValue, logEvent, logLineText, KEEP_ONLINE_DEFAULT_MINUTES, OPERATION_JOB_KINDS, type AccessGatewayState, type ApiErrorBody, type ConfigUpdateInput, type ConsoleStatus, type HealthResponse, type Installation, type Job, type JobKind, type JobState, type LogEntry, type LogEvent, type LogLine, type LogSink, type LogSourceFilter, type LegalReview, type ManagerPorts, type ManagerUpdateStatus, type OnlineState, type PortSettings, type Profile, type ProfileLayout, type SetupStatus, type StartupSettings, type TunnelState, type VersionSelector } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, storageDurability, storageReport, type PlatformPaths } from '../../../packages/platform/src/index.js';
import { INSTALL_CANCELED, RuntimeError, RuntimeManager, type InstallationProgress } from '../../../packages/sillytavern-runtime/src/index.js';
import { hashPassword, MIN_PASSWORD_LENGTH, validatePasscode, validatePassword, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { parseSessionCookie, SessionStore, clearSessionCookie, sessionCookie } from './sessions.js';
import { HandoffStore } from './cloudflare-handoff.js';
import { StateStore } from './state.js';
import { LOG_LIMITS, LogBuffer } from './log-buffer.js';
import { eraseManagerData } from './reset.js';
import { SystemStore } from './system.js';
import { panelStaticRoot } from './bootstrap.js';
import { ProcessSupervisor } from './supervisor.js';
import { AccessGateway } from './gateway.js';
import { ACCESS_GATEWAY_PORT, checkSillyTavernPort, findFreePort, isPortFree, MANAGER_PORT, PortError, portWasDemanded, resolveAccessPort, resolveConsolePort, SILLYTAVERN_PORT, type ResolvedPort } from './ports.js';
import { previewImage, previewLogo, previewManifest } from './preview.js';
import { TunnelManager } from '../../../packages/tunnel/src/index.js';
import { ProfileError, ProfileStore } from '../../../packages/profiles/src/index.js';
import { BackupError, BackupStore } from '../../../packages/backup/src/index.js';
import { CloudflareConnection, R2Error, R2Manager, type R2UpdateInput } from '../../../packages/r2/src/index.js';
import { CloudflareApiError, CloudflareOAuthError, CloudflareRateLimitError, DEFAULT_SCOPES, PROXY_WORKER_TARGETS, ProxyWorkerManager, type ProxyWorkerTarget } from '../../../packages/cloudflare/src/index.js';
import { BackupScheduler, syncProfileToR2 } from './r2-scheduler.js';
import { fetchSnapshotToLibrary, isProfileEmpty, recoverProfileFromR2 } from './r2-restore.js';
import { TransferMeter } from './progress.js';
import { MetricsStore } from './metrics.js';
import { ActivityMeter } from './activity.js';
import { ReleaseWatch } from './manager-release.js';
import { OnlineKeeper } from './online.js';
import { applyManagerSettings, foreignManagerSettings, managerSettingsOffer, restoreFromBucketIfBlank, saveManagerSettings, type ManagerSettingsDeps } from './manager-settings.js';
import type { ManagerSettingsRecord } from '../../../packages/contracts/src/index.js';
import { instrumentationLoaderPath } from '../../../packages/instrumentation/src/index.js';
import { ConfigError, ConfigStore } from '../../../packages/config/src/index.js';
import { DEFAULT_TELEMETRY_ENDPOINT, DEFAULT_TELEMETRY_ENROLLMENT_ENDPOINT, TelemetryTransport } from '../../../packages/telemetry/src/index.js';
import { LEGAL_META } from '../../../packages/legal/src/index.js';

const MAX_JSON_BYTES = 128 * 1024;
/** Both named by the legal package, so what is reported is what is shown. */
const TERMS_VERSION = LEGAL_META.effective;
const TELEMETRY_NOTICE_VERSION = LEGAL_META.effective;
const COOKIE_NAME = 'stm_session';

const NOTICE = {
  telemetry: 'This free software collects limited usage metadata to support the project. It never sends API keys, prompts, chats, model responses, or request logs.',
  terms: 'By continuing, you acknowledge the terms and the disclaimer.',
  disclaimer: 'You are responsible for your SillyTavern data, credentials, providers, backups, and compliance with applicable service terms.',
} as const;


/**
 * The Cloudflare OAuth client this project registered.
 *
 * A public client: it has no secret, so shipping its ID is how it is meant to be
 * used. Anyone running their own manager can register a client in their own
 * Cloudflare account and point `STM_CLOUDFLARE_OAUTH_CLIENT_ID` at it, or set it
 * empty to turn signing in to Cloudflare off and keep to S3 keys.
 */
const DEFAULT_CLOUDFLARE_CLIENT_ID = '042dda365c8407a62549886823a5fa4c';
/**
 * Where Cloudflare sends the browser back to.
 *
 * Cloudflare only accepts a redirect it has registered, matched exactly, and a
 * manager can be on any port and any address. The registered one is a page on
 * the project's domain that forwards to the origin the sign-in started from.
 */
const DEFAULT_CLOUDFLARE_REDIRECT_URI = 'https://stm.locmaymo.top/oauth/cloudflare/callback';
/** Where the relay, or Cloudflare itself for a loopback client, sends the browser on this manager. */
export const CLOUDFLARE_CALLBACK_PATH = '/oauth/cloudflare/callback';

const PROTECTED_PATHS = new Set([
  '/api/v1/versions',
  '/api/v1/installations',
  '/api/v1/profiles',
  '/api/v1/backups',
  '/api/v1/config',
  '/api/v1/config/port',
  '/api/v1/access/security',
  '/api/v1/access/password',
  '/api/v1/access/network',
  '/api/v1/access/sessions',
  '/api/v1/access/embed-session',
  '/api/v1/preview',
  '/api/v1/preview/image',
  '/api/v1/auth/password',
  '/api/v1/metrics',
  '/api/v1/system',
  '/api/v1/system/measure',
  '/api/v1/startup',
  '/api/v1/status',
  '/api/v1/legal',
  '/api/v1/legal/acknowledge',
  '/api/v1/tunnel',
  '/api/v1/manager-tunnel',
  '/api/v1/r2',
]);

/**
 * How often a console being read goes and asks the bucket who owns it.
 *
 * Short enough that somebody who has just signed in on another machine finds
 * this one already knowing, rather than after a reload; long enough that a
 * console left open all day is a few hundred reads, not a few hundred
 * thousand.
 */
const CLAIM_LOOK_MS = 5 * 60 * 1000;

export interface ManagerServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly paths?: PlatformPaths;
  readonly store?: StateStore;
  readonly sessions?: SessionStore;
  readonly rateLimiter?: RateLimiter;
  readonly managerVersion?: string;
  readonly secureCookies?: boolean;
  /** Null keeps to the request headers; absent reads the environment. */
  readonly publicOrigin?: string | null;
  readonly staticRoot?: string;
  readonly logger?: LogSink;
  readonly runtime?: RuntimeManager;
  readonly logBuffer?: LogBuffer;
  readonly supervisor?: ProcessSupervisor;
  readonly tunnel?: TunnelManager;
  /** The console's own tunnel, separate from the one that publishes SillyTavern. */
  readonly managerTunnel?: TunnelManager;
  readonly gateway?: AccessGateway;
  /** Overridable so tests can bind an ephemeral port instead of 8001. */
  readonly accessPort?: number;
  readonly profileStore?: ProfileStore;
  readonly backupStore?: BackupStore;
  readonly r2?: R2Manager;
  /** Null turns signing in to Cloudflare off; absent builds it from the environment. */
  readonly cloudflare?: CloudflareConnection | null;
  /**
   * The Workers that give the tunnels a fixed address.
   *
   * Absent builds one from the Cloudflare sign-in, which is the only way it
   * happens outside a test: a test that wants the console to know its own
   * fixed address should not have to hold an OAuth grant to say so.
   */
  readonly proxy?: ProxyWorkerManager | null;
  readonly metrics?: MetricsStore;
  readonly config?: ConfigStore;
  readonly telemetry?: TelemetryTransport;
  /**
   * Where the published manager versions are read from.
   *
   * Overridable so a test can answer that question without a request to
   * GitHub, and so nothing here goes to the network on a machine that only
   * asked for a server.
   */
  readonly releases?: ReleaseWatch;
  /**
   * What keeps this manager online; see `online.ts`.
   *
   * Overridable so a test can watch it take a turn against a clock it holds,
   * rather than against four real minutes.
   */
  readonly online?: OnlineKeeper;
  /**
   * Called when a launcher that knows STM_SHUTDOWN_TOKEN asks to shut down.
   *
   * Windows has no SIGTERM, so a launcher closing its window can only kill this
   * process - which leaves SillyTavern and cloudflared running with nothing
   * owning them. This gives it a way to ask instead.
   */
  readonly onShutdownRequest?: () => void;
}

export interface ManagerServer {
  readonly server: Server;
  /** Writes a line to the manager log, so a fault can say what it was. */
  readonly logger: LogSink;
  readonly store: StateStore;
  readonly sessions: SessionStore;
  readonly runtime: RuntimeManager;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly managerTunnel: TunnelManager;
  readonly gateway: AccessGateway;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly metrics: MetricsStore;
  readonly config: ConfigStore;
  readonly telemetry: TelemetryTransport;
  readonly releases: ReleaseWatch;
  readonly online: OnlineKeeper;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * The ports this process is actually using, as the routes see them.
 *
 * The console's and the gateway's are fixed for the life of the process, which
 * is why they are numbers; SillyTavern's can move, which is why it is a pair of
 * functions rather than a value read once at startup.
 */
/**
 * An outside address the environment named, and how much authority it carries.
 *
 * `configured` is somebody having written `STM_PUBLIC_ORIGIN` down, which
 * outranks anything the console worked out for itself - including a tunnel it
 * opened. `platform` is the console recognising where it is running, which a
 * tunnel deliberately opened afterwards should outrank in turn: the usual
 * reason to open one is that the platform's own address did not work.
 */
interface EnvironmentOrigin {
  readonly origin: string;
  readonly source: 'configured' | 'platform';
}

interface ServerPorts {
  readonly manager: number;
  readonly access: number;
  readonly sillyTavern: () => number;
  readonly setSillyTavern: (port: number) => void;
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly originTrusted: boolean;
  /** Every address the panel is reached at from outside, best first. */
  readonly publicOrigins: readonly string[];
  /** What a proxy in front of this manager publishes it at, if anything does. */
  readonly proxiedOrigin: string | null;
  readonly ports: ServerPorts;
  readonly sessionToken: string | undefined;
}

export async function startManagerServer(options: ManagerServerOptions = {}): Promise<ManagerServer> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? getPlatformPaths({ env });
  const store = options.store ?? new StateStore(
    options.managerVersion ? { paths, managerVersion: options.managerVersion } : { paths },
  );
  const sessions = options.sessions ?? new SessionStore();
  const rateLimiter = options.rateLimiter ?? new RateLimiter();
  const baseLogger: LogSink = options.logger ?? ((line) => console.log(logLineText(line)));
  const jobs = new JobStore(options.logBuffer ?? new LogBuffer(paths));
  const logger: LogSink = (line) => { jobs.append('manager', line); baseLogger(line); };
  /**
   * The port SillyTavern runs on, as everything that needs it reads it.
   *
   * A variable rather than a constant because the console can move it while it
   * runs, and the gateway, the supervisor, the installer's health check and the
   * config writer all have to see the same answer. Its stored value is read
   * below, once the state file has been loaded; until then the shipped port
   * stands.
   */
  let sillyTavernPort: number = SILLYTAVERN_PORT;
  const runtime = options.runtime ?? new RuntimeManager({ paths, healthCheckPort: () => sillyTavernPort, logger: (line) => { jobs.append('installer', line); baseLogger(line); } });
  const profiles = options.profileStore ?? new ProfileStore({ paths, logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  const backups = options.backupStore ?? new BackupStore({ paths, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  const cloudflare = options.cloudflare !== undefined ? options.cloudflare : cloudflareConnectionFromEnvironment(paths, env);
  const r2 = options.r2 ?? new R2Manager({
    paths,
    env,
    ...(cloudflare ? { cloudflare } : {}),
    logger: (line) => { jobs.append('backup', line); baseLogger(line); },
    /*
     * The account has gone to another machine, so what was deployed into it
     * is no longer ours to remember.
     *
     * The two fixed-address Workers live in that account under names that do
     * not depend on the machine, so the manager that took the account has
     * deployed over them and they answer at its tunnel now. Keeping the
     * record here would leave the console handing out an address that reaches
     * somebody else's machine, and would let a later sign-in from here decide
     * there was nothing to redeploy. `proxy` is defined below and this only
     * ever runs long after that.
     */
    onSurrender: () => { void proxy?.forget().catch(() => undefined); },
  });
  /*
   * The fixed addresses in front of the tunnels, when there is a Cloudflare
   * account to put them in.
   *
   * A Quick Tunnel's hostname is random and different every time cloudflared
   * starts, so the address somebody was given yesterday is gone today - and
   * gone as `DNS_PROBE_FINISHED_NXDOMAIN`, because the name is no longer in
   * DNS at all. A Worker on the account's own `workers.dev` subdomain has a
   * name that does not move, and is redeployed at whatever the current tunnel
   * is. Null when nobody has signed in to Cloudflare: there is then nowhere to
   * put one, and the tunnel address is the only address there is.
   */
  /**
   * The console's own fixed address, as a plain string.
   *
   * Kept here rather than asked of `proxy` where it is needed: `publicOrigins`
   * is answered inside a request and cannot wait on a file read, and this
   * changes about as often as somebody signs in to Cloudflare.
   */
  let managerProxyOrigin: string | null = null;
  const proxy = options.proxy !== undefined ? options.proxy : (cloudflare
    ? new ProxyWorkerManager({
      api: cloudflare.cloudflareApi(),
      stateDirectory: paths.state,
      // The Worker manager names its own lines, so they can be read in the
      // reader's language like every other line the manager writes. It used to
      // hand over one code for all of them, which left the English text as the
      // only thing there was to show.
      logger: (code, message, params) => logger(logEvent(code, message, params)),
    })
    : null);
  /**
   * Point one of those Workers at the address a tunnel has just announced.
   *
   * Everything about this is best effort. Publishing is a write to somebody
   * else's Cloudflare account over a network that fails, and the tunnel works
   * perfectly well without it - so a failure is written down and the tunnel's
   * own address goes on being the address. It is also why nothing awaits this:
   * a deploy takes seconds, and the switch that started the tunnel must not
   * wait for one.
   */
  const followTunnel = async (target: ProxyWorkerTarget, url: string | null, options: { readonly create?: boolean } = {}): Promise<void> => {
    if (!proxy || !cloudflare) return;
    const account = await cloudflare.workersAccount();
    if (!account) return;
    // Nothing to keep pointing anywhere: no tunnel now, none before, and no
    // reason given to make one. `create` is what a fresh sign-in passes, so
    // the reader is given their permanent address before they first use it.
    if (url === null && !options.create && await proxy.urlFor(target) === null) return;
    // Already deployed, in this account, pointing here. Redeploying would be a
    // write to somebody's Cloudflare account that changes nothing - and this
    // is now called speculatively, from the console's own status answer.
    if (await proxy.isPublished(account.id, target, url)) return;
    try {
      const record = await proxy.publish(account.id, target, url);
      if (target === 'manager') managerProxyOrigin = record.url;
    } catch (error: unknown) {
      logger(logEvent('cloudflare.proxyFailed', `[cloudflare] the fixed address for ${target === 'manager' ? 'the console' : 'SillyTavern'} could not be updated: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    }
  };
  /**
   * Make sure both fixed addresses exist and point where they should.
   *
   * Called when a Cloudflare account has just been connected, which is the
   * moment the manager first has somewhere to put them - and the moment to
   * tell the reader what their two permanent addresses are, whether or not
   * either tunnel happens to be on yet.
   */
  const publishProxies = (): void => {
    void followTunnel('sillyTavern', tunnel.getState().url, { create: true });
    void followTunnel('manager', managerTunnel.getState().url, { create: true });
  };
  // What was deployed the last time this manager ran, so its own address is
  // known before the tunnel has come back and asked for a redeploy.
  void proxy?.urlFor('manager').then((url) => { managerProxyOrigin = url; }).catch(() => undefined);
  const metrics = options.metrics ?? new MetricsStore(paths);
  // Sign-ins that happened in a window of their own, waiting to be collected
  // by the console that started them; see cloudflare-handoff.ts.
  const handoffs = new HandoffStore();
  const config = options.config ?? new ConfigStore({ managedPort: () => sillyTavernPort, logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  // Where the console binds, which is also which addresses its ports have to be
  // free on. Read here rather than at `listen` below, because everything from
  // the gateway's frame policy to SillyTavern's port is settled against a
  // console port that has already been proven bindable.
  const consolePortChoice = resolveConsolePort(env);
  /*
   * Which addresses to answer on.
   *
   * The loopback address on a machine somebody is sitting at, so the console is
   * not on the house network until they say so. Every address in a container,
   * because the only thing that can reach a container's loopback is the
   * container - Docker and every hosted workspace have always been that case,
   * and a host that named the port it publishes in `PORT` is the same case wearing a
   * different name: something in front of this process is going to connect to
   * it, and it will not be connecting from inside.
   */
  const defaultHost = paths.platform === 'docker' || paths.platform === 'hosted' || consolePortChoice.source === 'platform' ? '0.0.0.0' : '127.0.0.1';
  const host = options.host ?? env.STM_HOST ?? defaultHost;
  /**
   * The console's own port, settled before anything else asks for one.
   *
   * Only from the environment, and only at startup: moving the port from a page
   * that is served on it would take that page down with it. A port the host
   * demanded is bound or the start fails, because on a host that publishes one
   * port, listening anywhere else is listening where nobody can knock.
   */
  const consolePort = options.port ?? await settlePort({
    resolved: consolePortChoice,
    host,
    reserved: [],
    // Nothing to move for, so nothing to say. The line that matters is the one
    // below, and only when the port actually moved.
    onMove: (from, to) => logger(logEvent('manager.portMoved', `[manager] port ${from} is already in use; the console is on ${to} instead`, { from, to })),
    onDemandedTaken: (port) => logger(logEvent('manager.portTaken', `[manager] port ${port} was asked for and is already in use; starting there anyway and letting it fail`, { port })),
  });
  /**
   * The access gateway's port, which steps aside the same way.
   *
   * Probed on every address rather than on the one it will bind, because a
   * service holding the port on this machine alone still holds it, and moving
   * for that is cheaper than a gateway that reports an error nobody expected.
   */
  const accessPort = options.accessPort ?? await settlePort({
    resolved: resolveAccessPort(env),
    host: '0.0.0.0',
    reserved: [consolePort],
    onMove: (from, to) => logger(logEvent('gateway.portMoved', `[gateway] port ${from} is already in use; the access gateway is on ${to} instead`, { from, to })),
    onDemandedTaken: (port) => logger(logEvent('gateway.portTaken', `[gateway] port ${port} was asked for and is already in use`, { port })),
  });
  // The console shows SillyTavern in a frame, and the console is the only
  // page allowed to. Both spellings of the loopback address are named because
  // which one is in the address bar is the reader's choice, not ours, and an
  // origin is compared as written.
  /** Filled in once the listener is up; an ephemeral port is not known before that. */
  let boundPort: number = consolePort;
  const gateway = options.gateway ?? new AccessGateway({
    port: accessPort,
    targetPort: sillyTavernPort,
    frameAncestors: [`http://127.0.0.1:${consolePort}`, `http://localhost:${consolePort}`],
    // The sign-in page shows SillyTavern's own mark, read from whatever
    // version is installed rather than kept in this repository.
    brandLogo: async () => {
      const installation = await runtime.getActiveInstallation();
      if (!installation || installation.status !== 'ready') return null;
      return join(installation.runtimePath, 'public', 'img', 'logo.png');
    },
    logger: (line) => { jobs.append('manager', line); baseLogger(line); },
  });
  const supervisor = options.supervisor ?? new ProcessSupervisor({
    runtime,
    port: () => sillyTavernPort,
    profileResolver: (installation) => profiles.getActiveForInstallation(installation.id),
    profileLifecycle: {
      prepare: async (profile, runtimePath) => {
        const installation = await runtime.getInstallation(profile.installationId);
        if (installation) {
          try {
            // The runtime about to be started may be older or newer than the
            // one this config was written for, and an older one refuses to
            // start at all if `listen` was left on for a newer one. Settle
            // that before anything copies the config into the runtime.
            await config.applyManagedDefaults(profile, installation);
          } catch (error: unknown) {
            if (!(error instanceof ConfigError) || error.code !== 'config_missing') throw error;
          }
        }
        // Preparing a legacy runtime rewrites the whole user directory, so no
        // backup may be reading it while this runs.
        return backups.runExclusive(() => profiles.prepareForRuntime(profile, runtimePath));
      },
      // Persisting one back deletes that directory and rebuilds it, which is
      // even less survivable for a backup walking it.
      persist: (profile, runtimePath, runtimeLayout) => backups.runExclusive(() => profiles.persistFromRuntime(profile, runtimePath, runtimeLayout)),
      legacyHeapMb: (profile) => profiles.recommendedLegacyHeapMb(profile),
    },
    instrumentationPath: instrumentationLoaderPath,
    metricsFile: metrics.filePath,
    logger: (line) => { jobs.append('sillytavern', line); baseLogger(line); },
  });
  const tunnel = options.tunnel ?? new TunnelManager({
    paths,
    env,
    targetUrl: `http://127.0.0.1:${accessPort}`,
    onUrl: (url) => { void followTunnel('sillyTavern', url); },
    beforeStart: async () => {
      if (!gateway.getState().passwordConfigured) throw new Error('Set the SillyTavern password before opening a public tunnel');
      if (gateway.getState().status !== 'running') await gateway.start();
    },
    logger: (line) => { jobs.append('cloudflared', line); baseLogger(line); },
  });
  /**
   * The console's own public address, for where the platform will not give it
   * one that works.
   *
   * SillyTavern's tunnel publishes the access gateway; this one publishes the
   * console itself, on a link of its own rather than a path under that one. The
   * two are handed out to different people - a chat link is shared, a console
   * link is not - and cloudflared tells this one its address, which is how the
   * console comes to know where it is on a platform that will not say.
   *
   * It refuses to open without the manager password. The gateway's tunnel
   * refuses without the SillyTavern password for the same reason, and this side
   * can install software and read the whole data directory.
   */
  const managerTunnel = options.managerTunnel ?? new TunnelManager({
    paths,
    env,
    stateFile: 'manager-tunnel-config.json',
    // Read at start rather than now: an ephemeral port is not known until the
    // listener has taken one.
    targetUrl: () => `http://127.0.0.1:${boundPort}`,
    onUrl: (url) => { void followTunnel('manager', url); },
    beforeStart: async () => {
      if ((await store.getPersisted()).adminPasswordHash === null) {
        throw new Error('Set the manager password before opening the console to the internet');
      }
    },
    logger: (line) => { jobs.append('cloudflared', line); baseLogger(line); },
  });
  // The local backup interval used to be stored with the R2 settings. Hand an
  // old value over to the backup library before the scheduler first reads it.
  // An unreadable R2 file must not stop the manager starting over this.
  try {
    const legacyLocalInterval = await r2.legacyLocalIntervalMinutes();
    if (legacyLocalInterval !== null) {
      await backups.adoptLegacySchedule(legacyLocalInterval);
      await r2.forgetLegacyLocalInterval();
    }
  } catch {
    // The default interval applies, and the R2 routes report the file's problem.
  }
  const scheduler = new BackupScheduler({
    backups, profiles, r2,
    logger: (line) => { jobs.append('backup', line); baseLogger(line); },
    saveSettings: () => saveManagerSettings({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, logger: baseLogger }),
    metricsFile: metrics.filePath,
    // Whether this bucket is still holding out a setup nobody here has
    // answered; see `waitingOnHandover`.
    handoverPending: async () => {
      const offer = await managerSettingsOffer({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, logger: baseLogger });
      return offer.available ? offer.label : null;
    },
  });
  scheduler.start();
  // Uploads interrupted by a closed tab leave gigabyte part files whose id no
  // longer exists anywhere. A day is long enough for a slow connection to
  // finish one and short enough that the volume does not fill up with them.
  void backups.sweepStaleUploads(24 * 60 * 60 * 1000).catch(() => undefined);
  // A backup killed mid-write leaves its partial archive, and an import killed
  // between moving the file and recording it leaves the whole upload.
  void backups.sweepOrphanArchives().catch(() => undefined);
  // Archives written before retention existed are still on the volume, and the
  // scheduler only prunes once it next writes one.
  void profiles.getActive().then((profile) => profile && backups.pruneCreated(profile.id)).catch(() => undefined);
  // Profile snapshots were uncompressed copies of the same recovery point the
  // backup library holds compressed. Nothing writes them now; take back the
  // space the old ones are still using.
  void profiles.removeLegacySnapshots().catch(() => undefined);
  const system = new SystemStore({
    paths,
    dataRoot: async () => {
      const profile = await profiles.getActive();
      return profile ? profile.dataPath : null;
    },
  });
  /*
   * Whether the manager itself has been superseded.
   *
   * Nothing is asked of GitHub here: the first look happens when a console
   * first asks, and the answer is kept for hours afterwards. A manager nobody
   * has a console open against never makes the request at all.
   */
  const releases = options.releases ?? new ReleaseWatch({
    ...(options.managerVersion ? { version: options.managerVersion } : {}),
    logger: baseLogger,
  });
  const secureCookies = options.secureCookies ?? env.STM_SECURE_COOKIES === '1';
  const environmentOrigin: EnvironmentOrigin | null = options.publicOrigin !== undefined
    ? (options.publicOrigin === null ? null : { origin: options.publicOrigin, source: 'configured' })
    : publicOriginFromEnvironment(env, consolePort);
  /**
   * Every address the console can be reached at from outside, best first.
   *
   * More than one can be true at once - a Codespace that also has the tunnel
   * open is reachable both ways - so this is a list rather than an answer.
   * Requests from any of them are trusted; the first is the one a sign-in is
   * sent back to. See EnvironmentOrigin for why the order is what it is.
   */
  const publicOrigins = (): readonly string[] => {
    const tunnelUrl = managerTunnel.getState().url?.replace(/\/$/u, '');
    const ordered = [
      ...(environmentOrigin?.source === 'configured' ? [environmentOrigin.origin] : []),
      /*
       * The Worker in front of the tunnel, ahead of the tunnel itself.
       *
       * Ahead, because it is the address that does not change, so it is the
       * one a sign-in should come back to and the one worth being in a link.
       * Named at all, because a browser at the Worker's address sends that as
       * its `Origin` while `Host` by then is the tunnel's random hostname:
       * without this the console refuses its own sign-in form, and the address
       * opens, shows the page, and cannot be used.
       *
       * Only while the tunnel is up. With nothing behind it the Worker answers
       * every request with its own "not open right now" page, so calling it an
       * address the console can be reached at would be untrue.
       */
      ...(tunnelUrl && managerProxyOrigin ? [managerProxyOrigin] : []),
      ...(tunnelUrl ? [tunnelUrl] : []),
      ...(environmentOrigin?.source === 'platform' ? [environmentOrigin.origin] : []),
    ];
    return ordered;
  };
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : panelStaticRoot(env);
  // Said once, at the top of the log, where somebody setting this up is
  // already looking. The console says it again where it can be acted on.
  const durability = storageReport(paths);
  if (durability.assurance === 'temporary') {
    logger(logEvent('storage.notDurable', `[manager] ${paths.root} is on ${durability.filesystem ?? 'temporary storage'}, which this machine does not keep across a restart; connect Cloudflare R2 so backups are held somewhere else`, { path: paths.root, filesystem: durability.filesystem ?? 'unknown' }));
  } else if (durability.assurance === 'unverified') {
    // Not a fault, and not silence either. This manager cannot tell whether
    // the machine under it is kept, and the one thing that makes the answer
    // not matter is a copy somewhere else.
    logger(logEvent('storage.notVerified', `[manager] this manager cannot tell whether ${paths.root} survives a restart here, so treat it as storage that may be temporary; connect Cloudflare R2 so backups are held somewhere else`, { path: paths.root, filesystem: durability.filesystem ?? 'unknown' }));
  }
  let persisted = await store.load();
  // A stored port that would now collide - because `STM_PORT` or
  // `STM_ACCESS_PORT` moved since it was chosen - is dropped rather than
  // obeyed: two services fighting for one port is worse than SillyTavern
  // being somewhere other than where it was left.
  try {
    sillyTavernPort = checkSillyTavernPort(persisted.sillyTavernPort, { manager: consolePort, access: accessPort });
  } catch (error: unknown) {
    logger(logEvent('config.portReset', `[config] SillyTavern's port ${persisted.sillyTavernPort} is no longer usable (${error instanceof Error ? error.message : 'unknown reason'}); using ${SILLYTAVERN_PORT}`, {
      port: persisted.sillyTavernPort,
      fallback: SILLYTAVERN_PORT,
      reason: error instanceof Error ? error.message : 'unknown reason',
    }));
    sillyTavernPort = SILLYTAVERN_PORT;
  }
  /*
   * And a port that is free in this manager's own bookkeeping but held by
   * something else on the machine moves too.
   *
   * SillyTavern is started by us and reports its failures through us, so an
   * address already in use here reads as "SillyTavern will not start" with the
   * real reason several screens up the log. Some hosts run their own service on
   * 8000; the reader did not put it there and cannot move it. Moving is the
   * only answer that leaves everything else - the gateway, the tunnel, the
   * frame - working exactly as before, because all of them ask this variable
   * where SillyTavern is rather than assuming.
   */
  if (!await isPortFree(sillyTavernPort, '127.0.0.1')) {
    const moved = await findFreePort(sillyTavernPort + 1, { reserved: [consolePort, accessPort], host: '127.0.0.1' });
    if (moved === null) {
      logger(logEvent('config.portBusy', `[config] port ${sillyTavernPort} is in use and no free port was found near it; SillyTavern will start there and may fail`, { port: sillyTavernPort }));
    } else {
      logger(logEvent('config.portMoved', `[config] port ${sillyTavernPort} is already in use; SillyTavern is on ${moved} instead`, { from: sillyTavernPort, to: moved }));
      sillyTavernPort = moved;
      await store.setSillyTavernPort(moved);
      persisted = await store.load();
    }
  }
  gateway.setTargetPort(sillyTavernPort);
  /*
   * Whether this process is a test.
   *
   * `NODE_TEST_CONTEXT` is the reliable half: Node's test runner gives each
   * file a child process, and that child sees neither `--test` in its own
   * argv nor `NODE_ENV=test` - so the three checks that were here answered
   * "no" in every test that mattered. The others stay for a suite run some
   * other way.
   */
  const testRuntime = process.env.NODE_TEST_CONTEXT !== undefined
    || process.env.NODE_ENV === 'test'
    || process.argv.includes('--test')
    || process.execArgv.includes('--test');
  const telemetryEndpoint = env.STM_TELEMETRY_ENDPOINT ?? (testRuntime ? undefined : DEFAULT_TELEMETRY_ENDPOINT);
  const telemetryEnrollmentEndpoint = env.STM_TELEMETRY_ENROLLMENT_ENDPOINT ?? (testRuntime ? undefined : DEFAULT_TELEMETRY_ENROLLMENT_ENDPOINT);
  /*
   * How much the manager itself is used, which none of the counts above can
   * say: a manager installed once and never opened looks exactly like one that
   * was never installed. See `activity.ts`.
   */
  const activity = new ActivityMeter({ paths, sillyTavernRunning: () => supervisor.getState().status === 'running' });
  await activity.start();
  const telemetry = options.telemetry ?? new TelemetryTransport({
    paths,
    metricsFile: metrics.filePath,
    usageFile: activity.logPath,
    installId: persisted.installId,
    appVersion: persisted.managerVersion,
    platform: paths.platform,
    ...(telemetryEndpoint ? { endpoint: telemetryEndpoint } : {}),
    ...(telemetryEnrollmentEndpoint ? { enrollmentEndpoint: telemetryEnrollmentEndpoint } : {}),
    ...(env.STM_TELEMETRY_ENROLLMENT_TOKEN ? { enrollmentToken: env.STM_TELEMETRY_ENROLLMENT_TOKEN } : {}),
    // No logger. Whether the project's receiver is up is nothing the person
    // running this can act on, and a receiver that is down printed the same
    // line into their terminal every ten seconds.
  });
  try {
    await telemetry.start();
  } catch {
    // Telemetry that cannot start is telemetry that does not run. Nothing else
    // depends on it, so there is nothing to report.
  }

  /*
   * Keeping this manager online where being unused is treated as being over.
   *
   * It is given what the environment says, what a browser last taught it, and
   * this machine's own loopback address to fall back on - in that order, and
   * never the Worker or the tunnel. Nothing waits on it and nothing depends on
   * it; see `online.ts`.
   */
  const online = options.online ?? new OnlineKeeper({
    configuredOrigin: environmentOrigin?.origin ?? null,
    seenOrigin: persisted.keepOnlineOrigin,
    localOrigin: () => `http://127.0.0.1:${boundPort.toString(10)}`,
    // Not waited for: the keeper has the address in hand either way, and what
    // this is for is the start after this one.
    rememberOrigin: (origin) => { void store.setKeepOnlineOrigin(origin).catch(() => undefined); },
    enabled: persisted.keepOnline,
    minutes: persisted.keepOnlineMinutes,
    logger: baseLogger,
  });
  online.start();

  const environmentPassword = env.STM_ADMIN_PASSWORD;
  if (environmentPassword && !persisted.adminPasswordHash) {
    const passwordError = validatePassword(environmentPassword);
    if (passwordError) {
      throw new Error(`STM_ADMIN_PASSWORD is invalid: ${passwordError}`);
    }
    await store.bootstrapAdminPassword(hashPassword(environmentPassword));
    persisted = await store.getPersisted();
    logger(logEvent('setup.passwordBootstrapped', '[setup] admin password bootstrapped from STM_ADMIN_PASSWORD'));
  }
  const shutdownToken = env.STM_SHUTDOWN_TOKEN?.trim() || null;
  /*
   * Whether a manager with its password just set installs SillyTavern itself.
   *
   * Not under the test runner, where a password is set dozens of times and a
   * Git fetch against the real network is nobody's intention, and not for
   * anyone who asks for it to be left alone.
   */
  const autoInstall = !testRuntime && env.STM_AUTO_INSTALL !== '0';
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      store,
      sessions,
      rateLimiter,
      handoffs,
      startedAt,
      secureCookies,
      publicOrigins: publicOrigins(),
      proxiedOrigin: environmentOrigin?.origin ?? null,
      ports: {
        // The port that was actually bound, which is not the one asked for when
        // the caller asked for an ephemeral one.
        manager: boundPort,
        access: accessPort,
        sillyTavern: () => sillyTavernPort,
        setSillyTavern: (port) => { sillyTavernPort = port; gateway.setTargetPort(port); },
      },
      staticRoot,
      platform: paths.platform,
      logger,
      runtime,
      jobs,
      supervisor,
      tunnel,
      managerTunnel,
      gateway,
      profiles,
      backups,
      r2,
      cloudflare,
      metrics,
      activity,
      config,
      system,
      releases,
      online,
      proxy,
      publishProxies,
      shutdownToken,
      autoInstall,
      onShutdownRequest: options.onShutdownRequest,
    }).catch((error: unknown) => {
      if (error instanceof RequestError) {
        sendError(response, error.statusCode, error.code, error.message);
        return;
      }
      if (error instanceof BackupError) {
        sendError(response, 400, error.code, error.message);
        return;
      }
      if (error instanceof R2Error) {
        sendError(response, error.code === 'r2_not_configured' ? 409 : 400, error.code, error.message);
        return;
      }
      if (error instanceof ConfigError) {
        sendError(response, error.code === 'config_missing' ? 409 : 400, error.code, error.message);
        return;
      }
      if (error instanceof CloudflareRateLimitError) {
        response.setHeader('retry-after', String(error.retryAfterSeconds));
        sendError(response, 429, error.code, error.message);
        return;
      }
      if (error instanceof CloudflareApiError || error instanceof CloudflareOAuthError) {
        // Cloudflare answered, and not with what was needed: a gateway problem,
        // not a fault in this manager.
        sendError(response, 502, error.code, error.message);
        return;
      }
      logger(logEvent('manager.requestFailed', `[manager] request failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
      if (!response.headersSent) {
        sendError(response, 500, 'internal_error', 'The manager could not complete the request');
      } else {
        response.destroy();
      }
    });
  });
  // Backups and SillyTavern streaming can last longer than Node's defaults.
  // Chunked uploads keep individual requests small, while these settings avoid
  // killing a slow Studio connection mid-request or mid-stream.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 120_000;
  const port = consolePort;
  await listen(server, host, port);
  const address = server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  boundPort = actualPort;
  // The door opens with the manager rather than with SillyTavern, so its
  // address is the same one every time and a saved bookmark keeps working.
  gateway.setPassword(persisted.accessPasswordHash, persisted.accessPasscode);
  await gateway.start(persisted.accessLanEnabled);
  // The tunnel publishes the gateway, not SillyTavern, so it can come back as
  // soon as the gateway is listening - it does not have to wait for SillyTavern
  // and it does not go away again when SillyTavern is restarted.
  void tunnel.resume().catch((error: unknown) => logger(logEvent('cloudflared.resumeFailed', `[cloudflared] the tunnel could not be restored: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
  // The console's own link comes back the same way, and only now: its target is
  // the port that was bound a few lines above.
  void managerTunnel.resume().catch((error: unknown) => logger(logEvent('cloudflared.resumeFailed', `[cloudflared] the console's tunnel could not be restored: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
  const activeInstallation = await runtime.getActiveInstallation();
  if (activeInstallation?.status === 'ready') {
    // There is one, however it got here, so the manager has no first install
    // left to do. Claiming it now is what stops an upgrade of the manager from
    // deciding, on a machine set up long before this existed, that nothing has
    // been installed yet.
    await store.claimFirstInstall();
    let readyInstallation = activeInstallation;
    try {
      readyInstallation = await runtime.migrateLegacyInstallation?.(activeInstallation) ?? activeInstallation;
      await profiles.ensureDefault({ installationId: readyInstallation.id, runtimePath: readyInstallation.runtimePath });
      const activeProfile = await profiles.getActive();
      // Before the config is written and before SillyTavern is started, so what
      // comes back is what gets configured and started rather than something
      // laid over a profile already in use.
      if (activeProfile) await recoverEmptyProfile(() => Promise.resolve(activeProfile), r2, backups, jobs, metrics.filePath);
      // Reading it first turns a missing config into the handled error below
      // rather than a fault during startup.
      const currentConfig = activeProfile ? await config.read(activeProfile, readyInstallation) : null;
      if (activeProfile && currentConfig) await config.applyManagedDefaults(activeProfile, readyInstallation);
      await runtime.cleanupLegacyRuntimeCopies?.(readyInstallation.id);
    } catch (error: unknown) {
      logger(logEvent('installer.legacyMigrationFailed', `[installer] legacy runtime migration failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    }
    // Started with the manager unless somebody has said not to. Off is for
    // whoever runs SillyTavern themselves, or opens the console only to look
    // at backups on a machine they do not want a second process on.
    if (persisted.autoStartSillyTavern) {
      void supervisor.start().catch((error: unknown) => logger(logEvent('sillytavern.autoStartFailed', `[sillytavern] automatic startup failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
    } else {
      logger(logEvent('sillytavern.autoStartOff', '[sillytavern] not started: starting it with the manager is switched off'));
    }
  } else {
    /*
     * Nothing installed, and a bucket set up in `.env` that already holds data.
     *
     * This is the machine that starts from nothing every time. It cannot be
     * given its profile back yet - a profile is made against an installation,
     * and there is not one - but it can say, before anybody wonders, that the
     * data is not lost and that installing is what brings it back. Said in the
     * log rather than made into a question: the settings are in `.env` because
     * somebody put them there, which is the decision already taken.
     */
    void announceRecoverable(r2, logger);
  }

  return {
    server,
    logger,
    store,
    sessions,
    runtime,
    port: actualPort,
    supervisor,
    tunnel,
    managerTunnel,
    gateway,
    profiles,
    backups,
    r2,
    metrics,
    config,
    telemetry,
    releases,
    online,
    // The meter closes first, so the part of today that has just been spent is
    // written down before the transport looks for finished days.
    close: async () => { online.close(); await activity.close(); await telemetry.close(); await scheduler.close(); await tunnel.close(); await managerTunnel.close(); await gateway.close(); await supervisor.close(); await backups.settle(); await profiles.settle(); await closeServer(server); },
  };
}

async function handleRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly store: StateStore;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly handoffs: HandoffStore;
  readonly startedAt: number;
  readonly secureCookies: boolean;
  readonly publicOrigins: readonly string[];
  /**
   * The address a proxy in front of this manager publishes it at, if there is
   * one: `STM_PUBLIC_ORIGIN`, or a Codespace's forwarded address.
   *
   * Its presence is the fact that matters, not its value: a manager reached
   * through a proxy is one where the loopback address is not anywhere a
   * browser is, whatever the headers say it is.
   */
  readonly proxiedOrigin: string | null;
  readonly ports: ServerPorts;
  readonly staticRoot: string;
  readonly platform: PlatformPaths['platform'];
  readonly logger: LogSink;
  readonly runtime: RuntimeManager;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly managerTunnel: TunnelManager;
  readonly gateway: AccessGateway;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly cloudflare: CloudflareConnection | null;
  readonly metrics: MetricsStore;
  /** How much the manager itself is used; see `activity.ts`. */
  readonly activity: ActivityMeter;
  readonly config: ConfigStore;
  readonly system: SystemStore;
  /** Whether a newer manager has been published; see `manager-release.ts`. */
  readonly releases: ReleaseWatch;
  /** What keeps this manager online; see `online.ts`. */
  readonly online: OnlineKeeper;
  readonly proxy: ProxyWorkerManager | null;
  /** Put the fixed addresses in place, for a Cloudflare account just connected. */
  readonly publishProxies: () => void;
  readonly shutdownToken: string | null;
  /**
   * Whether the manager may install SillyTavern by itself on a first run.
   *
   * Off under the test runner and for anyone who sets `STM_AUTO_INSTALL=0`:
   * the install is a Git fetch and an `npm install` against the real network,
   * which is not something a test that sets a password has asked for.
   */
  readonly autoInstall: boolean;
  readonly onShutdownRequest: (() => void) | undefined;
}): Promise<void> {
  const { request, response, store, sessions, rateLimiter, handoffs, startedAt, publicOrigins, proxiedOrigin, ports, staticRoot, platform, logger, runtime, jobs, supervisor, tunnel, managerTunnel, gateway, profiles, backups, r2, cloudflare, metrics, activity, config, system, releases, online, proxy, publishProxies, shutdownToken, autoInstall, onShutdownRequest } = options;
  // Whether the browser's side of this connection is HTTPS, which is not the
  // same question as whether ours is: a hosted console is reached over HTTPS
  // that a proxy terminates before us, and only the proxy's own header says so.
  const secureCookies = options.secureCookies || requestIsSecure(request);
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const context: RequestContext = {
    request,
    response,
    pathname,
    searchParams: url.searchParams,
    originTrusted: isTrustedOrigin(request, publicOrigins),
    publicOrigins,
    proxiedOrigin,
    ports,
    sessionToken: parseSessionToken(request),
  };

  /*
   * Put SillyTavern on a machine that has none, without being asked.
   *
   * Making the reader find and press Install is asking them to confirm the
   * only thing this program does. It runs once per installation of the manager
   * - claimed under the state file's own write queue - so somebody who later
   * removes SillyTavern on purpose does not find it putting itself back. The
   * console follows the job it produces the same way it follows one somebody
   * pressed for, and can stop it.
   *
   * Both ways of setting a manager up end here. It used to hang off the
   * password screen alone, so a machine opened with a Cloudflare account -
   * the way that exists for machines which are wiped and put back together -
   * was the one way of arriving that left the reader on an empty console with
   * nothing running and nothing happening.
   */
  const adoptSillyTavernPort = (port: number): Promise<void> =>
    adoptRestoredPort({ ports, supervisor, profiles, runtime, config, logger }, port);
  const adoptKeepOnline = (enabled: boolean, minutes: number): void => { online.setEnabled(enabled, minutes); };

  const firstInstall = async (wanted?: string | null): Promise<void> => {
    if (!autoInstall) return;
    if ((await runtime.listInstallations()).length > 0) return;
    if (!await store.claimFirstInstall()) return;
    // The release this machine was running, where the bucket remembers one.
    const selector = releaseToInstall(wanted);
    try {
      await beginInstallation({ runtime, jobs, supervisor, profiles, backups, r2, system, metrics }, selector);
      logger(selector === 'latest'
        ? logEvent('installer.firstRun', '[installer] installing SillyTavern, because this manager has just been set up and has none')
        : logEvent('installer.firstRunPinned', `[installer] installing SillyTavern ${selector}, the release this machine was running before it was lost`, { version: selector }));
    } catch (error: unknown) {
      // Nothing is owed here: the console shows Install, and the reader can
      // press it. A first run must not fail over this.
      logger(logEvent('installer.firstRunFailed', `[installer] the first installation could not be started: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    }
  };

  if (pathname === CLOUDFLARE_CALLBACK_PATH && (request.method ?? 'GET') === 'GET') {
    await handleCloudflareCallback(context, sessions, cloudflare, r2, publishProxies, options.logger, handoffs, {
      store, backups, runtime, secureCookies, rateLimiter,
      restoreEverything: () => restoreAfterSignIn({
        store, backups, r2, runtime, jobs, profiles, gateway, metrics, supervisor,
        tunnel, managerTunnel, ports, firstInstall, adoptSillyTavernPort, adoptKeepOnline, logger: options.logger,
      }),
    });
    return;
  }
  if (!pathname.startsWith('/api/v1/')) {
    await servePanel(request, response, pathname, staticRoot);
    return;
  }
  if (!context.originTrusted) {
    sendError(response, 403, 'origin_rejected', 'Request origin is not allowed');
    return;
  }

  const method = request.method ?? 'GET';
  if (pathname === '/api/v1/health' && method === 'GET') {
    const state = await store.getPersisted();
    const health: HealthResponse = {
      status: 'ok',
      manager: { version: state.managerVersion, port: ports.manager },
      setupRequired: state.adminPasswordHash === null,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      // Asked of the filesystem the data is actually on, rather than of the
      // platform's name: the same image is durable with a volume mounted at the
      // data directory and not without one, and its name says neither.
      storage: { durable: storageDurability(store.paths.root).durable },
    };
    sendJson(response, 200, health);
    return;
  }

  if (pathname === '/api/v1/shutdown' && method === 'POST') {
    // Absent unless a launcher started this process and shared a secret with
    // it, so the panel's own origin cannot reach it and neither can anything
    // else on the machine that has not been told the token.
    const supplied = headerValue(request.headers['x-stm-shutdown-token']);
    if (!shutdownToken || !supplied || !constantTimeStringEqual(supplied, shutdownToken)) {
      sendError(response, 404, 'not_found', 'Route not found');
      return;
    }
    sendJson(response, 202, { ok: true });
    onShutdownRequest?.();
    return;
  }

  if (pathname === '/api/v1/setup/status' && method === 'GET') {
    const state = await store.getPersisted();
    const status: SetupStatus = {
      // A manager an account already owns is set up, password or no password:
      // that account can open it, which is the whole of what setup produces.
      setupRequired: state.adminPasswordHash === null && state.ownerAccountId === null,
      termsVersion: TERMS_VERSION,
      telemetryNoticeVersion: TELEMETRY_NOTICE_VERSION,
      notice: NOTICE,
      cloudflareSignIn: { available: cloudflare !== null, owner: state.ownerAccountName ?? state.ownerAccountId },
    };
    sendJson(response, 200, status);
    return;
  }

  /*
   * Open the console with a Cloudflare account instead of a password.
   *
   * Unauthenticated on purpose - not having a session is the point - and rate
   * limited like the password form beside it. The first account to sign in
   * claims the manager; after that only that account is let in, which is the
   * same rule as the first person to reach a manager with no password being
   * the one who sets it.
   *
   * This is what makes a machine that is wiped every few days usable: there is
   * nothing to set up again, because the sign-in is the setup and everything
   * that was on the machine comes back with it.
   */
  if (pathname === '/api/v1/auth/cloudflare' && method === 'POST') {
    if (!checkRateLimit(context, rateLimiter)) return;
    if (!cloudflare) { sendError(response, 409, 'cloudflare_not_available', 'This manager has no Cloudflare sign-in configured'); return; }
    const returnOrigin = panelOrigin(context);
    if (!returnOrigin) { sendError(response, 400, 'invalid_origin', 'The panel origin could not be read'); return; }
    const url = cloudflare.beginConnect(returnOrigin, 'signIn');
    sendJson(response, 200, { url, ...openHandoff(context, handoffs, url) });
    return;
  }

  /*
   * Collect a sign-in that finished in a window of its own.
   *
   * Unauthenticated, because a sign-in is how a console gets a session in the
   * first place - the name is the credential, and it is one this manager
   * issued a moment ago to the page now asking for it. See
   * cloudflare-handoff.ts for why the browser cannot carry this itself.
   */
  if (pathname === '/api/v1/cloudflare/handoff' && method === 'POST') {
    const body = await readJson(request);
    const secret = isRecord(body) && typeof body.handoff === 'string' ? body.handoff : '';
    const claim = secret ? handoffs.claim(secret) : null;
    // Nothing is waiting under that name: never issued, already collected, or
    // out of time. Said plainly, so the console stops asking.
    if (!claim) { sendError(response, 404, 'not_found', 'There is no sign-in waiting under that name'); return; }
    if (claim.status === 'waiting') { sendJson(response, 200, { ready: false }); return; }
    const { outcome, code, sessionToken } = claim.result;
    sendJson(response, 200, {
      ready: true,
      outcome,
      code,
      ...(sessionToken && sessions.get(sessionToken)
        ? { session: sessions.get(sessionToken), token: sessionToken }
        : {}),
    });
    return;
  }

  if (pathname === '/api/v1/setup/password' && method === 'POST') {
    await handlePasswordSetup(context, store, sessions, rateLimiter, secureCookies, firstInstall);
    return;
  }

  if (pathname === '/api/v1/auth/login' && method === 'POST') {
    await handleLogin(context, store, sessions, rateLimiter, secureCookies);
    return;
  }

  if (pathname === '/api/v1/auth/session' && method === 'GET') {
    const session = requireSession(context, sessions);
    if (!session) return;
    // The token comes back with it; see `parseSessionToken`. This request
    // already carried the session, so saying which one it was grants nothing
    // the caller did not just present.
    sendJson(response, 200, { session, token: context.sessionToken });
    return;
  }

  if (pathname === '/api/v1/auth/logout' && method === 'POST') {
    const session = requireSession(context, sessions);
    if (!session) {
      return;
    }
    if (!requireCsrf(context, session.csrfToken)) {
      return;
    }
    sessions.revoke(context.sessionToken);
    response.setHeader('Set-Cookie', clearSessionCookie(secureCookies));
    sendJson(response, 200, { ok: true });
    return;
  }

  /*
   * Erase everything this manager keeps, and be a new one.
   *
   * Its own route rather than a corner of the settings page's API, because it
   * is not a setting: it removes SillyTavern, every chat and character in every
   * profile, every backup on this disk, the R2 connection, the tunnel, the PIN
   * and the manager's own password. Nothing else here asks for the password of
   * somebody who is already signed in, and this asks for it because a signed-in
   * console left open on a desk is not consent to that.
   *
   * Handled here rather than with the other runtime routes so that it can end
   * the session it was asked through: the password it was checked against no
   * longer exists by the time it answers.
   */
  if (pathname === '/api/v1/reset' && method === 'POST') {
    const session = requireSession(context, sessions);
    if (!session) return;
    if (!requireCsrf(context, session.csrfToken)) return;
    await handleReset(context, { store, sessions, jobs, supervisor, tunnel, managerTunnel, gateway, runtime, profiles, backups, online, logger, secureCookies });
    return;
  }

  /*
   * Whether the program being looked at has been superseded.
   *
   * Handled here rather than with the runtime routes because it is about the
   * manager itself rather than about anything the manager runs, and because it
   * must never make the console wait on GitHub: the answer is whatever the
   * last look found, and a look that is due is started and left to land in a
   * later ask. The exception is a console that has never been told anything at
   * all, which waits once - otherwise the first answer would arrive an hour
   * after the page that wanted it.
   */
  if (pathname === '/api/v1/manager-update' && method === 'GET') {
    const session = requireSession(context, sessions);
    if (!session) return;
    if (releases.status().checkedAt === null) await releases.check();
    else void releases.check().catch(() => undefined);
    sendJson(response, 200, releases.status() satisfies ManagerUpdateStatus);
    return;
  }

  /*
   * Whether this manager keeps itself online, and how that is going.
   *
   * Here rather than with the runtime routes for the same reason as the one
   * above: it is about the manager rather than about anything it runs, and
   * what it needs is the keeper, which the runtime routes have no business
   * holding. Writing it is two things at once - the file, so the next start
   * agrees, and the keeper, so this one does.
   */
  if (pathname === '/api/v1/online' && (method === 'GET' || method === 'PUT')) {
    const session = requireSession(context, sessions);
    if (!session) return;
    if (method === 'PUT') {
      if (!requireCsrf(context, session.csrfToken)) return;
      const body = await readJson(request);
      if (!isRecord(body) || typeof body.enabled !== 'boolean') {
        sendError(response, 400, 'invalid_input', 'enabled must be true or false');
        return;
      }
      if (body.minutes !== undefined && (typeof body.minutes !== 'number' || !Number.isFinite(body.minutes))) {
        sendError(response, 400, 'invalid_input', 'minutes must be a number');
        return;
      }
      // Absent leaves the interval where it is, so a console that only moved
      // the switch does not also reset a schedule somebody chose.
      const minutes = body.minutes === undefined ? online.state().minutes : body.minutes;
      await store.setKeepOnline(body.enabled, minutes);
      online.setEnabled(body.enabled, minutes);
      // Not waited for. The answer is the switch having moved; what the first
      // attempt finds arrives in the next read, and this one must not sit on a
      // request to somewhere that may be timing out.
      if (body.enabled) void online.tick().catch(() => undefined);
    }
    sendJson(response, 200, online.state() satisfies OnlineState);
    return;
  }

  const needsAuth = isProtectedPath(pathname);
  if (needsAuth) {
    const session = requireSession(context, sessions);
    if (!session) {
      return;
    }
    if (method !== 'GET' && !requireCsrf(context, session.csrfToken)) {
      return;
    }
    await handleRuntimeRequest(context, store, runtime, jobs, supervisor, tunnel, managerTunnel, gateway, profiles, backups, r2, cloudflare, metrics, activity, config, system, online, proxy, publishProxies, logger, handoffs);
    return;
  }

  sendError(response, 404, 'not_found', 'Route not found');
}

interface ResetDeps {
  readonly store: StateStore;
  readonly sessions: SessionStore;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly managerTunnel: TunnelManager;
  readonly gateway: AccessGateway;
  readonly runtime: RuntimeManager;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly online: OnlineKeeper;
  readonly logger: LogSink;
  readonly secureCookies: boolean;
}

/**
 * Take the manager back to the state it was in before anybody used it.
 *
 * The order matters, and it is the order of who is holding what. SillyTavern
 * runs out of a profile directory, so it stops first - on Windows a running
 * process is enough to make its own directory undeletable. Both tunnels are
 * turned off rather than left to notice their configuration has gone. The two
 * stores that write in the background are allowed to finish what they have
 * started, because a write that lands after the delete would put the first file
 * back into an empty tree.
 *
 * Then the directories go, and only then what is held in memory. Four stores
 * keep what they last read: the state store would go on answering with the
 * password that has just been erased and write it back on the next change, and
 * the other three would go on listing an installation, profiles and backups
 * whose files are gone. The door is holding the PIN, and every console session
 * was opened with a password this manager no longer knows. The reply
 * clears the cookie of the session that asked, so the page that gets it lands
 * on the first-run screen rather than on a console with nothing behind it.
 *
 * A job in flight is the one thing that stops all of this. An install or a
 * restore is writing into the directories about to be deleted, and racing it
 * would leave files from the old manager inside the new one - so the answer is
 * to say so and let the operator stop it.
 */
async function handleReset(context: RequestContext, deps: ResetDeps): Promise<void> {
  const { request, response } = context;
  const { store, sessions, jobs, supervisor, tunnel, managerTunnel, gateway, runtime, profiles, backups, online, logger, secureCookies } = deps;
  const body = await readJson(request);
  const password = isRecord(body) && typeof body.password === 'string' ? body.password : '';
  const persisted = await store.getPersisted();
  if (!persisted.adminPasswordHash) {
    sendError(response, 409, 'setup_required', 'This manager has not been set up yet');
    return;
  }
  if (!password || !verifyPassword(password, persisted.adminPasswordHash)) {
    sendError(response, 403, 'invalid_password', 'That is not this manager password');
    return;
  }
  const running = jobs.activeInstallation() ?? jobs.activeOperation();
  if (running) {
    sendError(response, 409, 'reset_busy', 'Stop the job that is still running, then erase everything');
    return;
  }
  logger(logEvent('manager.resetting', '[manager] erasing everything this manager keeps, because the console asked for it'));
  await supervisor.stop('uninstall');
  await tunnel.disable();
  await managerTunnel.disable();
  await backups.settle();
  await profiles.settle();
  const report = await eraseManagerData(store.paths, logger);
  await Promise.all([store.forget(), runtime.forget(), profiles.forget(), backups.forget()]);
  gateway.setPassword(null, false);
  gateway.signOutEveryone();
  await gateway.setLan(false);
  // Back to what a manager nobody has touched does, along with everything
  // else: the file that said otherwise has just been deleted, and a keeper
  // still holding the old answer would disagree with the state it is in.
  // The switch and the schedule, but not the address it has learned: a reset
  // erases what is on the machine, and does not move the machine. The console
  // is about to reload onto the first-run screen from that same address.
  online.setEnabled(true, KEEP_ONLINE_DEFAULT_MINUTES);
  sessions.revokeAll();
  response.setHeader('Set-Cookie', clearSessionCookie(secureCookies));
  sendJson(response, 200, {
    ok: report.failures.length === 0,
    erased: report.removed.length,
    failures: report.failures.map((failure) => ({ path: failure.path, reason: failure.reason })),
  });
}

/** What moving SillyTavern onto a restored port takes. */
interface PortAdoptionDeps {
  readonly ports: ServerPorts;
  readonly supervisor: ProcessSupervisor;
  readonly profiles: ProfileStore;
  readonly runtime: RuntimeManager;
  readonly config: ConfigStore;
  readonly logger: LogSink;
}

/**
 * Move this manager onto a SillyTavern port that came back with a restore.
 *
 * The state file is only half of it: the gateway forwards to a port it was
 * told at startup, the health check waits on that one, and config.yaml is
 * written with it. A restore that wrote the file alone left all three where
 * they were, so a machine that came back saying it runs SillyTavern on 8006
 * started it on 8002 - and every other restored setting being right made that
 * read as the manager ignoring the port on purpose.
 *
 * Anything already running is moved with it, the same way the port row on the
 * settings page moves it. A restart that fails is not allowed to take the rest
 * of the restore down: the port has already moved, and the next start uses it.
 */
async function adoptRestoredPort(deps: PortAdoptionDeps, port: number): Promise<void> {
  const { ports, supervisor, profiles, runtime, config, logger } = deps;
  if (port === ports.sillyTavern()) return;
  const wasRunning = supervisor.getState().status === 'running';
  try {
    if (wasRunning) await supervisor.stop('configChange');
    ports.setSillyTavern(port);
    const profile = await profiles.getActive();
    const installation = await runtime.getActiveInstallation();
    if (profile && installation?.status === 'ready') {
      // Absent until SillyTavern has been installed and started once, which is
      // the usual state of a machine being put back together.
      try { await config.applyManagedDefaults(profile, installation); }
      catch (error: unknown) { if (!(error instanceof ConfigError) || error.code !== 'config_missing') throw error; }
    }
    if (wasRunning) await supervisor.start();
  } catch (error: unknown) {
    logger(logEvent('config.portAdoptFailed', `[config] SillyTavern could not be moved onto the restored port ${port}: ${error instanceof Error ? error.message : 'unknown error'}`, { port, reason: error instanceof Error ? error.message : 'unknown error' }));
  }
}

async function handleRuntimeRequest(context: RequestContext, store: StateStore, runtime: RuntimeManager, jobs: JobStore, supervisor: ProcessSupervisor, tunnel: TunnelManager, managerTunnel: TunnelManager, gateway: AccessGateway, profiles: ProfileStore, backups: BackupStore, r2: R2Manager, cloudflare: CloudflareConnection | null, metrics: MetricsStore, activity: ActivityMeter, config: ConfigStore, system: SystemStore, online: OnlineKeeper, proxy: ProxyWorkerManager | null, publishProxies: () => void, logger: LogSink, handoffs: HandoffStore): Promise<void> {
  const { pathname, ports, request, response, searchParams } = context;
  const method = request.method ?? 'GET';
  const adoptSillyTavernPort = (port: number): Promise<void> =>
    adoptRestoredPort({ ports, supervisor, profiles, runtime, config, logger }, port);
  const adoptKeepOnline = (enabled: boolean, minutes: number): void => { online.setEnabled(enabled, minutes); };
  if (pathname === '/api/v1/auth/password' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.password !== 'string' || typeof body.confirmPassword !== 'string' || body.password !== body.confirmPassword) {
      sendError(response, 400, 'password_confirmation_mismatch', 'Enter the same manager password twice');
      return;
    }
    const passwordError = validatePassword(body.password);
    if (passwordError) {
      sendError(response, 400, 'invalid_password', passwordError);
      return;
    }
    /*
     * Set, not changed: a console opened with a Cloudflare account has never
     * had a password, and asking for one here is the only way to get one.
     *
     * This used to refuse that with "finish setting the manager up first", on
     * a manager the reader was signed in to and using - which is also the
     * advice least able to help, because the screen that sets a first password
     * is the one they can no longer reach. Whoever is asking is already
     * through the session check above, which is the whole of what this needs
     * to know.
     */
    await store.setAdminPassword(hashPassword(body.password));
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === '/api/v1/config/validate' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.rawYaml !== 'string') { sendError(response, 400, 'invalid_input', 'A YAML document is required'); return; }
    sendJson(response, 200, { valid: true, settings: await config.validate(body.rawYaml) });
    return;
  }
  if (pathname === '/api/v1/config' && (method === 'GET' || method === 'PUT')) {
    const profile = await profiles.getActive();
    const installation = await runtime.getActiveInstallation();
    if (!profile || !installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'Install SillyTavern before editing its configuration'); return; }
    if (method === 'GET') { sendJson(response, 200, await decorateConfig(await config.read(profile, installation))); return; }
    const input = parseConfigUpdateInput(await readJson(request));
    const wasRunning = supervisor.getState().status === 'running';
    // Stop before writing. A runtime old enough to keep its own copy of the
    // config has that copy synchronized back into the profile when it stops,
    // so a config written first is overwritten by the restart that was meant
    // to apply it - which is why nothing the panel saved ever took effect.
    if (wasRunning) await supervisor.stop('configChange');
    const saved = await config.update(profile, installation, input);
    const process = wasRunning ? await supervisor.start() : supervisor.getState();
    sendJson(response, 200, { config: await decorateConfig(saved), process, tunnel: tunnel.getState() });
    return;
  }
  /**
   * Move SillyTavern to another port.
   *
   * Its own route rather than a field of the config editor, because the number
   * has to be checked against the console's port and the gateway's before
   * anything is written, and because moving it means restarting SillyTavern:
   * leaving the door pointed at a port nothing answers on would read as
   * SillyTavern having crashed.
   */
  if (pathname === '/api/v1/config/port' && method === 'GET') {
    // The reserved pair comes back with it: the panel needs to say which port
    // is taken and by what, rather than only that the number was refused.
    const settings: PortSettings = { port: ports.sillyTavern(), reserved: { manager: ports.manager, access: ports.access } };
    sendJson(response, 200, settings);
    return;
  }
  if (pathname === '/api/v1/config/port' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body)) { sendError(response, 400, 'invalid_input', 'A port is required'); return; }
    let port: number;
    try {
      port = checkSillyTavernPort(body.port, { manager: ports.manager, access: ports.access });
    } catch (error: unknown) {
      if (error instanceof PortError) { sendError(response, 400, error.code, error.message); return; }
      throw error;
    }
    if (port === ports.sillyTavern()) { sendJson(response, 200, { port, process: supervisor.getState() }); return; }
    const wasRunning = supervisor.getState().status === 'running';
    if (wasRunning) await supervisor.stop('configChange');
    await store.setSillyTavernPort(port);
    ports.setSillyTavern(port);
    // Write it into the file too, so a reader of config.yaml is not told one
    // thing while SillyTavern is started with another.
    const profile = await profiles.getActive();
    const installation = await runtime.getActiveInstallation();
    if (profile && installation?.status === 'ready') {
      try { await config.applyManagedDefaults(profile, installation); }
      catch (error: unknown) { if (!(error instanceof ConfigError) || error.code !== 'config_missing') throw error; }
    }
    const process = wasRunning ? await supervisor.start() : supervisor.getState();
    sendJson(response, 200, { port, process });
    return;
  }
  if (pathname === '/api/v1/config/reset' && method === 'POST') {
    const profile = await profiles.getActive();
    const installation = await runtime.getActiveInstallation();
    if (!profile || !installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'Install SillyTavern before editing its configuration'); return; }
    // Same order as a save, and for the same reason: a runtime that keeps its
    // own copy of the config writes it back when it stops.
    const wasRunning = supervisor.getState().status === 'running';
    if (wasRunning) await supervisor.stop('configChange');
    const restored = await config.restoreDefaults(profile, installation);
    const process = wasRunning ? await supervisor.start() : supervisor.getState();
    sendJson(response, 200, { config: await decorateConfig(restored), process, tunnel: tunnel.getState() });
    return;
  }
  if (pathname === '/api/v1/access/security' && method === 'GET') {
    sendJson(response, 200, await decorateSecurity(gateway.getState()));
    return;
  }
  if (pathname === '/api/v1/access/password' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.password !== 'string' || typeof body.confirmPassword !== 'string' || body.password !== body.confirmPassword) {
      sendError(response, 400, 'password_confirmation_mismatch', 'Enter the same SillyTavern password twice');
      return;
    }
    const invalid = validatePasscode(body.password);
    if (invalid) { sendError(response, 400, 'invalid_passcode', invalid); return; }
    const passwordHash = hashPassword(body.password);
    await store.setAccessPassword(passwordHash, true);
    // Whoever was already inside is signed out, so a password changed because
    // it was shared too widely takes effect immediately rather than at the
    // next restart.
    gateway.setPassword(passwordHash, true);
    if (gateway.getState().status !== 'running') await gateway.start();
    sendJson(response, 200, await decorateSecurity(gateway.getState()));
    return;
  }
  /*
   * A way into SillyTavern for the console that is already signed in.
   *
   * The cookie is set here, on the manager's own origin, and the gateway on
   * its own port reads it - which works because cookies are scoped by host and
   * not by port, so one set for 127.0.0.1 is sent to every port on it. That is
   * the whole trick: the embedded view needs no PIN because the session behind
   * it was issued to somebody who had already given the console's password.
   */
  if (pathname === '/api/v1/access/embed-session' && method === 'POST') {
    if (gateway.getState().status !== 'running') await gateway.start();
    const { token, maxAgeSeconds } = gateway.issueSession();
    response.setHeader('Set-Cookie', gateway.sessionCookie(request, token, maxAgeSeconds));
    sendJson(response, 200, await decorateSecurity(gateway.getState()));
    return;
  }
  /*
   * The reader's own wallpaper and characters, for the still on the overview.
   *
   * Read-only, and only ever the two directories `preview.ts` names. The
   * manifest is one request and each image is another, so the console can show
   * the frame before the pictures arrive rather than waiting on all of them.
   */
  if (pathname === '/api/v1/preview' && method === 'GET') {
    const profile = await profiles.getActive();
    if (!profile) { sendJson(response, 200, { background: null, theme: null, recent: [] }); return; }
    sendJson(response, 200, await previewManifest(userDataRoot(profile)));
    return;
  }
  if (pathname === '/api/v1/preview/image' && method === 'GET') {
    const kind = searchParams.get('kind');
    const name = searchParams.get('name');
    // The mark belongs to the installed copy of SillyTavern rather than to a
    // profile, so it is fetched from the runtime and needs no name.
    if (kind === 'logo') {
      const installation = await runtime.getActiveInstallation();
      const mark = installation && installation.status === 'ready' ? await previewLogo(installation.runtimePath) : null;
      if (!mark) { sendError(response, 404, 'not_found', 'There is no SillyTavern mark to show'); return; }
      sendImage(response, mark);
      return;
    }
    if ((kind !== 'background' && kind !== 'avatar') || !name) { sendError(response, 400, 'invalid_input', 'A preview image needs a kind and a name'); return; }
    const profile = await profiles.getActive();
    const image = profile ? await previewImage(userDataRoot(profile), kind, name) : null;
    if (!image) { sendError(response, 404, 'not_found', 'That preview image is not there'); return; }
    sendImage(response, image);
    return;
  }
  if (pathname === '/api/v1/access/sessions' && method === 'DELETE') {
    gateway.signOutEveryone();
    sendJson(response, 200, await decorateSecurity(gateway.getState()));
    return;
  }
  if (pathname === '/api/v1/access/network' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.lan !== 'boolean') { sendError(response, 400, 'invalid_input', 'Local network access must be on or off'); return; }
    if (body.lan && !gateway.getState().passwordConfigured) {
      sendError(response, 409, 'public_access_password_required', 'Set the SillyTavern password before enabling network access');
      return;
    }
    await store.setAccessLan(body.lan);
    sendJson(response, 200, await decorateSecurity(await gateway.setLan(body.lan)));
    return;
  }
  if (pathname === '/api/v1/r2' && method === 'GET') {
    // This used to list the bucket to show how many objects were in it. With
    // nine thousand of them that is ten charged listings for every load of the
    // page - more charged operations than a day of backups - to display a
    // number the manager already keeps. `/api/v1/r2/objects` still lists, for
    // when somebody actually asked to see the contents.
    // The durability of this machine's disk rides along with the backup
    // settings because it is the same question: whether a copy somewhere else
    // is a precaution or the only thing keeping the data.
    sendJson(response, 200, { config: await r2.getConfig(), storage: storageReport(store.paths) });
    return;
  }
  if (pathname === '/api/v1/r2' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body)) { sendError(response, 400, 'invalid_input', 'A JSON object is required'); return; }
    const input: R2UpdateInput = {
      ...(body.mode === 'keys' || body.mode === 'cloudflare' ? { mode: body.mode } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.endpoint === 'string' || body.endpoint === null ? { endpoint: body.endpoint as string | null } : {}),
      ...(typeof body.bucket === 'string' || body.bucket === null ? { bucket: body.bucket as string | null } : {}),
      ...(typeof body.accessKeyId === 'string' || body.accessKeyId === null ? { accessKeyId: body.accessKeyId as string | null } : {}),
      ...(typeof body.secretAccessKey === 'string' || body.secretAccessKey === null ? { secretAccessKey: body.secretAccessKey as string | null } : {}),
      ...(typeof body.hotIntervalMinutes === 'number' ? { hotIntervalMinutes: body.hotIntervalMinutes } : {}),
      ...(typeof body.coldIntervalHours === 'number' ? { coldIntervalHours: body.coldIntervalHours } : {}),
      ...(typeof body.reconcileIntervalHours === 'number' ? { reconcileIntervalHours: body.reconcileIntervalHours } : {}),
      ...(typeof body.keepRecent === 'number' ? { keepRecent: body.keepRecent } : {}),
      ...(typeof body.keepDaily === 'number' ? { keepDaily: body.keepDaily } : {}),
      ...(typeof body.keepWeekly === 'number' ? { keepWeekly: body.keepWeekly } : {}),
      ...(typeof body.maxStorageBytes === 'number' ? { maxStorageBytes: body.maxStorageBytes } : {}),
      ...(typeof body.maxWriteOperations === 'number' ? { maxWriteOperations: body.maxWriteOperations } : {}),
    };
    sendJson(response, 200, { config: await r2.update(input) });
    return;
  }
  if (pathname === '/api/v1/r2/usage' && method === 'GET') {
    sendJson(response, 200, await r2.cloudflareUsage({ refresh: searchParams.get('refresh') === '1' }));
    return;
  }
  if (pathname.startsWith('/api/v1/r2/cloudflare')) {
    await handleCloudflareRequest(context, cloudflare, r2, proxy, publishProxies, logger, handoffs);
    return;
  }
  // The one question about the bucket: is it reachable, and what is in it. It
  // replaced three buttons that each answered part of it and then said so in a
  // notification that went away.
  if (pathname === '/api/v1/r2/check' && method === 'POST') {
    sendJson(response, 200, { check: await r2.inspect(), config: await r2.getConfig() });
    return;
  }
  /*
   * The manager's own settings, as some machine left them in the bucket.
   *
   * Offered rather than applied: what comes back carries the hash of a console
   * password, and replacing this console's password is not something to do
   * without being asked. See `manager-settings.ts`.
   */
  if (pathname === '/api/v1/r2/settings' && method === 'GET') {
    /*
     * Who holds the bucket, asked here because this is what a console asks as
     * it opens.
     *
     * The claim is otherwise only read on the way into a write, and a manager
     * with nothing to send does not write - so a machine that had the account
     * taken from it went on saying "this machine is backing up", which is
     * exactly the machine somebody opens the console on to find out why their
     * backups stopped. One charged read, at most once a minute.
     */
    await r2.refreshClaim({ atMostEvery: 60_000 }).catch(() => undefined);
    /*
     * And not while this manager is already acting on it.
     *
     * Signing in on a blank machine starts the restore by itself, before the
     * browser has even been redirected back. The console then opened, asked
     * this, and put the card up - "this account holds the setup of another
     * machine, restore it?" - over a restore that was seconds into doing
     * exactly that. It flashed for a few seconds and vanished when the
     * settings landed, which reads as a button somebody was too slow to press.
     */
    const offer = jobs.activeOperation()
      ? { available: false, label: null, writtenAt: null, mine: false, hasAdminPassword: false, hasAccessPassword: false }
      : await managerSettingsOffer({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, logger });
    sendJson(response, 200, { settings: offer, owner: (await r2.getConfig()).owner ?? null });
    return;
  }
  /*
   * "Not these" - the other answer, and the one that was only ever a note in
   * one browser.
   *
   * It has to reach the manager, because the card is not the only thing
   * waiting on it: until this machine has said what it wants, nothing of its
   * own is uploaded over what the bucket is holding. A dismissal the server
   * never heard about left that wait running for the life of the connection.
   */
  if (pathname === '/api/v1/r2/settings/dismiss' && method === 'POST') {
    const record = await foreignManagerSettings({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, logger });
    if (record) await r2.answerSettingsOffer(record.writtenAt);
    sendJson(response, 200, { dismissed: record !== null });
    return;
  }
  if (pathname === '/api/v1/r2/settings' && method === 'POST') {
    const saved = await saveManagerSettings({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, logger });
    sendJson(response, 200, { saved });
    return;
  }
  /*
   * Everything this account remembers about a machine, put back here, now.
   *
   * One press rather than the three it used to take - restore the settings,
   * then notice which release they named and install it, then find the
   * recovery point and restore that - each on a different card, each needing
   * the reader to know the other two existed.
   *
   * It is the same work a Cloudflare sign-in does by itself on a blank
   * machine, which is why it is the same function: there is one way a machine
   * is put back together, and a press and a sign-in must not drift apart.
   */
  if (pathname === '/api/v1/r2/restore' && method === 'POST') {
    const lost = await lostTheAccount(r2);
    if (lost) { sendError(response, 409, 'r2_in_use', displacedMessage(lost)); return; }
    /*
     * The release the bucket remembers, installed whatever is here already.
     *
     * Not the first-run install, which stands down the moment it finds an
     * installation - right for something nobody asked for, and the opposite of
     * what a press means when the machine is on the wrong release.
     */
    const installRelease = async (wanted?: string | null): Promise<void> => {
      await beginInstallation({ runtime, jobs, supervisor, profiles, backups, r2, system, metrics }, releaseToInstall(wanted));
    };
    // Detached: this is minutes of installing and downloading, and the console
    // follows it as the ordinary background job it is.
    void restoreAfterSignIn({
      store, backups, r2, runtime, jobs, profiles, gateway, metrics, supervisor,
      tunnel, managerTunnel, ports, firstInstall: installRelease, adoptSillyTavernPort, adoptKeepOnline, logger, force: true,
    }).catch((error: unknown) => {
      logger(logEvent('r2.settingsRestoreFailed', `[r2] this machine could not be brought back from the bucket: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    });
    sendJson(response, 202, { started: true });
    return;
  }
  if (pathname === '/api/v1/r2/settings/restore' && method === 'POST') {
    const lost = await lostTheAccount(r2);
    if (lost) { sendError(response, 409, 'r2_in_use', displacedMessage(lost)); return; }
    const body = await readJson(request);
    const record = await foreignManagerSettings({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, logger });
    if (!record) { sendError(response, 404, 'manager_settings_missing', 'This account holds no manager settings'); return; }
    const result = await applyManagerSettings({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, adoptSillyTavernPort, adoptKeepOnline, logger }, record, {
      // Both default to on: somebody who asked for this asked for all of it,
      // and the panel is what offers the parts separately.
      passwords: !isRecord(body) || body.passwords !== false,
      schedules: !isRecord(body) || body.schedules !== false,
      ports: { manager: ports.manager, access: ports.access },
    });
    // The gateway is holding the credential and the binding this machine had
    // a moment ago, neither of which is what it was just told to use.
    const restored = await store.getPersisted();
    gateway.setPassword(restored.accessPasswordHash, restored.accessPasscode);
    const security = await gateway.setLan(restored.accessLanEnabled);
    sendJson(response, 200, { ...result, security });
    return;
  }
  if (pathname === '/api/v1/r2/objects' && method === 'GET') {
    sendJson(response, 200, { objects: await r2.listObjects() });
    return;
  }
  if (pathname === '/api/v1/r2/objects' && method === 'DELETE') {
    const body = await readJson(request);
    const key = isRecord(body) && typeof body.key === 'string' ? body.key : '';
    if (!key) { sendError(response, 400, 'invalid_object_key', 'An R2 object key is required'); return; }
    await r2.deleteObject(key);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === '/api/v1/r2/snapshots' && method === 'GET') {
    /*
     * Every recovery point in the bucket, not this profile's.
     *
     * A profile identifier is made on the machine that made the profile, so a
     * machine that has just been set up - a hosted one that starts empty, a new
     * computer, a reinstall - has an identifier the bucket has never seen. Asking
     * for its own points came back with none, and the panel said the bucket was
     * empty over a bucket holding a year of them. The one moment somebody most
     * needs to see what is there is the moment they have just connected, and it
     * was the one moment this showed nothing.
     *
     * The chunks are shared across every profile in the bucket, so a point from
     * another one costs no more to bring back and restores the same way. Which
     * profile each belongs to comes back with it, for the panel to say so.
     */
    const profile = await profiles.getActive();
    const snapshots = await r2.listSnapshots().catch(() => []);
    sendList(response, 'snapshots', snapshots, searchParams, { searchText: snapshotSearchText, sortValue: snapshotSortValue }, { activeProfileId: profile?.id ?? null });
    return;
  }
  const snapshotMatch = /^\/api\/v1\/r2\/snapshots\/([^/]+)\/fetch$/u.exec(pathname);
  if (snapshotMatch && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before fetching a recovery point'); return; }
    const snapshotId = snapshotMatch[1] ?? '';
    // Which profile in the bucket it belongs to, when that is not this one.
    // Sent by the panel from the row it was pressed on; a point of this
    // profile's own needs nothing and says nothing.
    const fetchBody = await readJson(request);
    const sourceProfileId = isRecord(fetchBody) && typeof fetchBody.profileId === 'string' && fetchBody.profileId ? fetchBody.profileId : profile.id;
    // Fetching lands it in the backup library rather than writing it straight
    // into the profile. Restoring is then the path that already exists, with
    // its preview, its safety snapshot and its merge-or-replace choice.
    // It produces a backup in the library, but it is not one: a panel that
    // reattaches to it has only the kind to name it by, and named a download
    // "Back up now" under the local backup card.
    const { job, signal } = jobs.createOperation('r2Fetch', logEvent('job.fetchingRecoveryPoint', 'Fetching the recovery point from R2'));
    const meter = new TransferMeter();
    void fetchSnapshotToLibrary({
      profile, r2, backups, snapshotId, sourceProfileId, signal,
      logger: (line) => jobs.append('backup', line),
      onProgress: (progress) => {
        const { percent, params } = meter.update(progress);
        jobs.updateOperation(job.id, percent, logEvent('job.fetchingChunks', `Fetching ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
      },
    })
      // The archive it landed as, so the panel can offer to put it back rather
      // than leaving the reader to find it in the library themselves.
      .then(({ manifest }) => jobs.finishOperation(job.id, 'succeeded', null, { backupId: manifest.id }))
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'The recovery point could not be fetched'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/r2/legacy' && method === 'DELETE') {
    sendJson(response, 200, await r2.deleteLegacyObjects());
    return;
  }
  if (pathname === '/api/v1/r2/reconcile' && method === 'POST') {
    sendJson(response, 200, await r2.reconcile());
    return;
  }
  // One R2 backup now, whatever the clock says. It sends the whole profile
  // rather than the frequent subset, because someone asking for it by hand is
  // asking for a complete recovery point.
  if ((pathname === '/api/v1/r2/upload' || pathname === '/api/v1/r2/sync') && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before uploading to R2'); return; }
    // A first upload of a profile is gigabytes and many minutes. Answering it
    // synchronously meant the panel had an indeterminate bar and no way to
    // stop - indistinguishable from a hang, and the reasonable response to a
    // hang is to kill it, which is the one thing that makes it take longer.
    const { job, signal } = jobs.createOperation('r2Upload', logEvent('job.sendingToR2', 'Sending to R2'));
    const meter = new TransferMeter();
    /*
     * Everything the slow clock sends, not only the chats.
     *
     * Somebody pressing Back up now is asking for this machine to be in the
     * bucket, and it used to send the profile alone - so the console password,
     * the passcode, the schedules, the release being run and the whole usage
     * history were still only ever written by a timer nobody can see. A reader
     * who pressed the button, watched it finish, and then lost the machine got
     * their chats back and nothing else, which is the exact shape of failure
     * the button exists to prevent.
     *
     * The two small ones go first because they are small: a handful of
     * kilobytes each, done before the bar has moved, and they are what a
     * machine needs in order to be a machine again. The profile is the part
     * worth a progress bar and it keeps one.
     */
    void (async () => {
      /*
       * Forced, both of them, because this is a press rather than a tick.
       *
       * Each of these has a shortcut that makes it free on the scheduler's
       * clock: the settings are compared with what this process remembers
       * sending, and the usage log with a stat this process wrote down. Both
       * are beliefs about the bucket rather than facts about it, and a press
       * is exactly how somebody asks whether the belief is true - so the press
       * goes and looks. That is what "Back up now" was not doing: it reported
       * success having sent neither, on a machine whose record in the bucket
       * had been overwritten by another one.
       */
      const settingsSent = await saveManagerSettings({ store, backups, r2, runtime, tunnel, managerTunnel, gateway, logger }, { force: true });
      jobs.append('backup', settingsSent
        ? logEvent('r2.uploadNowSettings', '[r2] the manager’s own settings are up to date in the bucket')
        : logEvent('r2.uploadNowSettingsSame', '[r2] the bucket already holds these manager settings'));
      // Its own catch: the usage log is the one part nobody restores by hand,
      // but it is also the one nobody would want to lose a backup over.
      const metricsSent = await r2.syncMetricsFile(metrics.filePath, { force: true }).catch(() => null);
      jobs.append('backup', metricsSent
        ? logEvent('r2.uploadNowMetrics', `[r2] the usage history is up to date in the bucket (${String(metricsSent.uploadedChunks)} chunk(s) sent)`, { chunks: metricsSent.uploadedChunks })
        : logEvent('r2.uploadNowMetricsSame', '[r2] the bucket already holds this usage history'));
      await syncProfileToR2({
        profile, backups, r2, tier: 'cold', signal,
        logger: (line) => jobs.append('backup', line),
        onProgress: (progress) => {
          const { percent, params } = meter.update(progress);
          jobs.updateOperation(job.id, percent, logEvent('job.sendingChunks', `Sending ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
        },
      });
    })()
      .then(() => jobs.finishOperation(job.id, 'succeeded', null))
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'The R2 backup failed'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/logs' && method === 'GET') {
    const afterValue = Number(searchParams.get('after') ?? 0);
    const sourceParam = searchParams.get('source') ?? 'all';
    if (!Number.isSafeInteger(afterValue) || afterValue < 0) { sendError(response, 400, 'invalid_cursor', 'The log cursor is invalid'); return; }
    if (!isLogSourceFilter(sourceParam)) { sendError(response, 400, 'invalid_source', 'The log source is invalid'); return; }
    const source = sourceParam === 'all' ? null : sourceParam;
    // `before` reads backwards through what is still retained, so a reader that
    // scrolls up can pull in older lines instead of only following new ones.
    const beforeParam = searchParams.get('before');
    if (beforeParam !== null) {
      const beforeValue = Number(beforeParam);
      const limitValue = Number(searchParams.get('limit') ?? LOG_LIMITS.historyEntries);
      if (!Number.isSafeInteger(beforeValue) || beforeValue < 0) { sendError(response, 400, 'invalid_cursor', 'The log cursor is invalid'); return; }
      if (!Number.isSafeInteger(limitValue) || limitValue < 1) { sendError(response, 400, 'invalid_limit', 'The log limit is invalid'); return; }
      sendJson(response, 200, jobs.logHistory(beforeValue, source, limitValue));
      return;
    }
    sendJson(response, 200, jobs.logs(afterValue, source));
    return;
  }
  if (pathname === '/api/v1/metrics' && method === 'GET') {
    const requestedDays = Number(searchParams.get('days') ?? 30);
    if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 90) {
      sendError(response, 400, 'invalid_metrics_range', 'Metrics range must be between 1 and 90 days');
      return;
    }
    // How much the manager was used rides along with how much was asked of
    // the providers, because the two are read together: hours that produced
    // no requests are as much a part of the picture as requests are.
    sendJson(response, 200, { ...(await metrics.snapshot(new Date(), requestedDays)), appUsage: await activity.summary(requestedDays) });
    return;
  }
  if (pathname === '/api/v1/versions' && method === 'GET') {
    const versions = await runtime.listVersions();
    sendJson(response, 200, { versions });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'GET') {
    const [installations, active] = await Promise.all([runtime.listInstallations(), runtime.getActiveInstallation()]);
    // The active pointer travels with the page: it names a row that may not be
    // on it, and the panel needs it to mark the row wherever it turns up.
    sendList(response, 'installations', installations, searchParams, { searchText: installationSearchText, sortValue: installationSortValue }, { activeInstallationId: active?.id ?? null, activeJob: jobs.activeInstallation() });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'DELETE') {
    await supervisor.stop('uninstall');
    try {
      await runtime.removeInstallations();
    } catch (error: unknown) {
      if (error instanceof RuntimeError) { sendError(response, 409, error.code, error.message); return; }
      throw error;
    }
    sendJson(response, 200, { ok: true, installations: [], activeInstallationId: null });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'POST') {
    const body = await readJson(request);
    const selector = isRecord(body) && typeof body.version === 'string' ? body.version : null;
    if (!selector || !isVersionSelector(selector)) {
      sendError(response, 400, 'invalid_version', 'A valid SillyTavern version must be selected');
      return;
    }
    try {
      const started = await beginInstallation({ runtime, jobs, supervisor, profiles, backups, r2, system, metrics }, selector as VersionSelector);
      sendJson(response, 202, { installationId: started.installationId, job: started.job });
    } catch (error: unknown) {
      if (error instanceof RuntimeError) { sendError(response, 409, error.code, error.message); return; }
      throw error;
    }
    return;
  }
  if (pathname === '/api/v1/profiles' && method === 'GET') {
    const activeInstallation = await runtime.getActiveInstallation();
    if (activeInstallation?.status === 'ready') await profiles.ensureDefault({ installationId: activeInstallation.id, runtimePath: activeInstallation.runtimePath });
    const items = await profiles.list();
    sendJson(response, 200, { profiles: items, activeProfileId: items.find((profile) => profile.active)?.id ?? null });
    return;
  }
  if (pathname === '/api/v1/profiles' && method === 'POST') {
    const body = await readJson(request);
    const name = isRecord(body) && typeof body.name === 'string' ? body.name : '';
    const layout = isRecord(body) && (body.layout === 'data' || body.layout === 'public') ? body.layout as ProfileLayout : undefined;
    const requestedInstallationId = isRecord(body) && typeof body.installationId === 'string' ? body.installationId : null;
    const installation = requestedInstallationId ? await runtime.getInstallation(requestedInstallationId) : await runtime.getActiveInstallation();
    if (!installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'Install SillyTavern before creating a profile'); return; }
    try {
      const profile = await profiles.create({ ...(layout ? { layout } : {}), name, installationId: installation.id, runtimePath: installation.runtimePath });
      sendJson(response, 201, profile);
    } catch (error: unknown) {
      if (error instanceof ProfileError) { sendError(response, 400, error.code, error.message); return; }
      throw error;
    }
    return;
  }
  const profileActivationMatch = /^\/api\/v1\/profiles\/([^/]+)\/activate$/u.exec(pathname);
  if (profileActivationMatch && method === 'POST') {
    const profile = await profiles.get(profileActivationMatch[1] ?? '');
    if (!profile) { sendError(response, 404, 'profile_not_found', 'Profile not found'); return; }
    const installation = await runtime.getInstallation(profile.installationId);
    if (!installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'The profile installation is not ready'); return; }
    const current = await profiles.getActive();
    await supervisor.stop('profileSwitch');
    let snapshot: Awaited<ReturnType<BackupStore['create']>> | null = null;
    try {
      if (current && current.id !== profile.id) snapshot = await backups.createSafetyCopy(current, { kind: 'before-switch' });
      await runtime.activateInstallation(installation.id);
      const activated = await profiles.activate(profile.id);
      const process = await supervisor.start();
      sendJson(response, 200, { profile: activated, process, safetySnapshot: snapshot });
    } catch (error: unknown) {
      if (error instanceof ProfileError) { sendError(response, 409, error.code, error.message); return; }
      throw error;
    }
    return;
  }
  if (pathname === '/api/v1/backups' && method === 'GET') {
    const activeProfile = await profiles.getActive();
    const list = activeProfile ? await backups.list(activeProfile.id) : [];
    sendList(response, 'backups', list, searchParams, { searchText: backupSearchText, sortValue: backupSortValue });
    return;
  }
  if (pathname === '/api/v1/backups' && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before creating a backup'); return; }
    const body = await readJson(request);
    const name = isRecord(body) && typeof body.name === 'string' ? body.name : undefined;
    /*
     * Two things are asked for here. `scheduled` is "Back up now": the
     * automatic backup, taken without waiting for the schedule, which replaces
     * the previous automatic one like any other. Anything else is a manual
     * backup, kept until somebody deletes it.
     *
     * An automatic backup of data that has not changed since the newest backup
     * would be an identical archive, so it is not written; the reply says so.
     */
    const kind = isRecord(body) && body.kind === 'scheduled' ? 'scheduled' : 'manual';
    if (kind === 'scheduled') {
      const fingerprint = await backups.fingerprint(profile);
      const newest = (await backups.list(profile.id))
        .filter((manifest) => manifest.source === 'created')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (newest?.fingerprint === fingerprint) { sendJson(response, 200, { unchanged: true, backup: newest }); return; }
    }
    const { job, signal } = jobs.createOperation('backup', logEvent('job.preparingBackup', 'Preparing backup'));
    void backups.create(profile, {
      ...(name && kind === 'manual' ? { name } : {}),
      kind,
      signal,
      onProgress: ({ completed, total }) => jobs.updateOperation(job.id, total > 0 ? (completed / total) * 90 : 50, logEvent('job.compressingFiles', `Compressing files (${completed}/${total})`, { completed, total })),
    }).then((manifest) => { jobs.updateOperation(job.id, 95, logEvent('job.savingLibrary', 'Saving backup library')); jobs.finishOperation(job.id, 'succeeded', null); return manifest; })
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'Backup failed'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/backups/schedule' && method === 'GET') {
    sendJson(response, 200, { schedule: await backups.getSchedule() });
    return;
  }
  if (pathname === '/api/v1/backups/schedule' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.intervalMinutes !== 'number') { sendError(response, 400, 'invalid_backup_schedule', 'intervalMinutes must be a number'); return; }
    sendJson(response, 200, { schedule: await backups.setSchedule({ intervalMinutes: body.intervalMinutes }) });
    return;
  }
  if (pathname === '/api/v1/backups/import/chunk' && method === 'POST') {
    const uploadId = searchParams.get('uploadId') ?? '';
    const index = Number(searchParams.get('index') ?? '');
    const chunk = await backups.appendUploadChunk(uploadId, index, request);
    sendJson(response, 200, { ok: true, ...chunk });
    return;
  }
  if (pathname === '/api/v1/backups/import/chunk' && method === 'DELETE') {
    const uploadId = searchParams.get('uploadId') ?? '';
    await backups.removeUpload(uploadId);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === '/api/v1/backups/import/finish' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.uploadId !== 'string' || typeof body.name !== 'string') {
      sendError(response, 400, 'invalid_upload', 'Upload id and file name are required');
      return;
    }
    const expectedBytes = typeof body.expectedBytes === 'number' ? body.expectedBytes : undefined;
    const archivePath = await backups.finishUpload(body.uploadId, expectedBytes);
    let retained = false;
    try {
      const profile = await profiles.getActive();
      if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before importing a backup'); return; }
      const imported = await backups.importArchive(profile, archivePath, body.name);
      retained = true;
      sendJson(response, 200, { ...imported.preview, backup: imported.manifest });
    } finally {
      if (!retained) await backups.removeTemporary(archivePath);
    }
    return;
  }
  const backupImportPreview = pathname === '/api/v1/backups/import/preview';
  const backupImportRestore = pathname === '/api/v1/backups/import/restore';
  if ((backupImportPreview || backupImportRestore) && method === 'POST') {
    const archivePath = await backups.saveUpload(request);
    let retained = false;
    try {
      const profile = await profiles.getActive();
      if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before importing a backup'); return; }
      const imported = await backups.importArchive(profile, archivePath, headerValue(request.headers['x-backup-name']));
      retained = true;
      if (backupImportPreview) { sendJson(response, 200, { ...imported.preview, backup: imported.manifest }); return; }
      const mode = headerValue(request.headers['x-restore-mode']);
      if (mode !== 'merge' && mode !== 'replace') { sendError(response, 400, 'invalid_restore_mode', 'Restore mode must be merge or replace'); return; }
      const libraryPath = await backups.getArchivePath(imported.manifest.id);
      if (!libraryPath) { sendError(response, 500, 'backup_archive_missing', 'The uploaded archive could not be stored'); return; }
      const force = headerValue(request.headers['x-restore-force']) === 'yes';
      const result = await restoreWithProcess({ profile, backups, archivePath: libraryPath, backupId: imported.manifest.id, mode, ...(force ? { force: true } : {}), supervisor });
      sendJson(response, 200, result);
    } finally {
      if (!retained) await backups.removeTemporary(archivePath);
    }
    return;
  }
  const backupMatch = /^\/api\/v1\/backups\/([^/]+)(?:\/(preview|restore|download))?$/u.exec(pathname);
  if (backupMatch) {
    const id = backupMatch[1] ?? '';
    const manifest = await backups.get(id);
    if (!manifest) { sendError(response, 404, 'backup_not_found', 'Backup not found'); return; }
    const action = backupMatch[2];
    if (!action && method === 'DELETE') {
      await backups.remove(id);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (!action && (method === 'PUT' || method === 'PATCH')) {
      const body = await readJson(request);
      const name = isRecord(body) && typeof body.name === 'string' ? body.name : '';
      if (!name.trim()) { sendError(response, 400, 'invalid_backup_name', 'Backup name is required'); return; }
      sendJson(response, 200, await backups.rename(id, name));
      return;
    }
    const archivePath = await backups.getArchivePath(id);
    if (!archivePath) { sendError(response, 410, 'backup_archive_missing', 'The backup archive is missing'); return; }
    if (!action && method === 'GET') { sendJson(response, 200, manifest); return; }
    if (action === 'download' && method === 'GET') {
      const details = await stat(archivePath);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Length', details.size.toString(10));
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(manifest.name)}`);
      createReadStream(archivePath).pipe(response);
      return;
    }
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before restoring a backup'); return; }
    if (action === 'preview' && method === 'POST') { sendJson(response, 200, await backups.preview(archivePath, profile.layout)); return; }
    if (action === 'restore' && method === 'POST') {
      const body = await readJson(request);
      const mode = isRecord(body) && (body.mode === 'merge' || body.mode === 'replace') ? body.mode : null;
      if (!mode) { sendError(response, 400, 'invalid_restore_mode', 'Restore mode must be merge or replace'); return; }
      // An archive that does not look like a profile is refused unless the
      // reader has been shown why and said to go ahead anyway. Asked here, so
      // the answer is a refusal with a code the panel can translate rather
      // than a job that starts and then fails in English.
      const force = isRecord(body) && body.force === true;
      if (!force && (await backups.preview(archivePath, profile.layout)).recognized === false) {
        sendError(response, 409, 'unrecognized_archive', 'This archive holds none of the folders a SillyTavern profile usually has');
        return;
      }
      const { job, signal } = jobs.createOperation('restore', logEvent('job.preparingRestore', 'Preparing restore'));
      void restoreWithProcess({ profile, backups, archivePath, backupId: id, mode, ...(force ? { force: true } : {}), supervisor, signal, onProgress: (progress, step) => jobs.updateOperation(job.id, progress, step) })
        .then(() => jobs.finishOperation(job.id, 'succeeded', null))
        .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'Restore failed', { evenIfCanceled: error instanceof RestoreRollbackError, stepCode: error instanceof RestoreRollbackError ? 'job.rollbackFailed' : undefined }));
      sendJson(response, 202, { jobId: job.id, job });
      return;
    }
  }
  const installationMatch = /^\/api\/v1\/installations\/([^/]+)(?:\/(start|stop|restart))?$/u.exec(pathname);
  if (installationMatch) {
    const installation = await runtime.getInstallation(installationMatch[1] ?? '');
    if (!installation) { sendError(response, 404, 'installation_not_found', 'Installation not found'); return; }
    const action = installationMatch[2];
    if (method === 'GET' && !action) { sendJson(response, 200, installation); return; }
    if (action && method === 'POST') {
      if (action === 'start') { sendJson(response, 200, await supervisor.start()); return; }
      const state = action === 'stop' ? await supervisor.stop() : await supervisor.restart();
      sendJson(response, 200, state);
      return;
    }
  }
  if (pathname === '/api/v1/process' && method === 'GET') { sendJson(response, 200, supervisor.getState()); return; }
  if (pathname === '/api/v1/process/start' && method === 'POST') { sendJson(response, 200, await supervisor.start()); return; }
  // SillyTavern stopping does not close the door in front of it. The tunnel
  // publishes the access gateway, which stays up and says SillyTavern is not
  // answering yet - so the public address survives a stop, a restart and a
  // version switch instead of being replaced by a different random one.
  if (pathname === '/api/v1/process/stop' && method === 'POST') { sendJson(response, 200, await supervisor.stop('requested')); return; }
  if (pathname === '/api/v1/process/restart' && method === 'POST') { sendJson(response, 200, await supervisor.restart()); return; }
  /*
   * The tunnel, and the fixed address in front of it.
   *
   * The Worker's address is added here rather than kept by the tunnel manager,
   * which knows nothing about Cloudflare accounts and should not. The panel
   * shows the fixed one and keeps the tunnel's own beside it, because that is
   * where the traffic really goes and it is worth being able to see.
   */
  if (pathname === '/api/v1/tunnel' && method === 'GET') { sendJson(response, 200, await withProxyUrl(tunnel.getState(), proxy, cloudflare, 'sillyTavern')); return; }
  if (pathname === '/api/v1/tunnel' && method === 'PUT') {
    const body = await readJson(request);
    const mode = isRecord(body) && (body.mode === 'off' || body.mode === 'quick' || body.mode === 'named') ? body.mode : null;
    if (!mode) { sendError(response, 400, 'invalid_tunnel_mode', 'Tunnel mode must be off, quick, or named'); return; }
    /*
     * SillyTavern does not have to be running, or installed.
     *
     * What the tunnel publishes is the access gateway, which is up from the
     * moment the manager is - the comment above `/process/stop` says so, and it
     * is why a public address survives a stop, a restart and a version switch.
     * Refusing to open it until SillyTavern answers contradicted that: it made
     * the address depend on the one thing it was built not to depend on, and
     * left somebody setting a machine up unable to do the two steps in the
     * order that suits them. Opened early, the gateway answers that SillyTavern
     * is not there yet, and starts serving it the moment it is.
     *
     * The PIN is a different matter and still required: it is what stands
     * between the internet and the data, and there is no sense in which it can
     * wait.
     */
    if (mode !== 'off' && !gateway.getState().passwordConfigured) { sendError(response, 409, 'public_access_password_required', 'Set the SillyTavern password before opening a public tunnel'); return; }
    const state = mode === 'off' ? await tunnel.disable() : await tunnel.start(mode, isRecord(body) && typeof body.token === 'string' ? body.token : undefined);
    sendJson(response, 200, await withProxyUrl(state, proxy, cloudflare, 'sillyTavern'));
    return;
  }
  /**
   * The console's own public link.
   *
   * Separate from the one above in every way that matters: it publishes the
   * console rather than the gateway, it has its own stored mode, and it waits
   * on the manager password rather than SillyTavern's. It does not wait on
   * SillyTavern running at all - the reason to open it is usually that the
   * platform's own address does not work, which is a problem the console has
   * whether or not anything is installed yet.
   */
  if (pathname === '/api/v1/manager-tunnel' && method === 'GET') { sendJson(response, 200, await withProxyUrl(managerTunnel.getState(), proxy, cloudflare, 'manager')); return; }
  if (pathname === '/api/v1/manager-tunnel' && method === 'PUT') {
    const body = await readJson(request);
    const mode = isRecord(body) && (body.mode === 'off' || body.mode === 'quick' || body.mode === 'named') ? body.mode : null;
    if (!mode) { sendError(response, 400, 'invalid_tunnel_mode', 'Tunnel mode must be off, quick, or named'); return; }
    // This link reaches the console, which installs software, reads the whole
    // data directory and holds the Cloudflare tokens. A password is the only
    // thing between it and whoever finds the address.
    if (mode !== 'off' && (await store.getPersisted()).adminPasswordHash === null) {
      sendError(response, 409, 'manager_password_required', 'Set the manager password before opening the console to the internet');
      return;
    }
    const state = mode === 'off' ? await managerTunnel.disable() : await managerTunnel.start(mode, isRecord(body) && typeof body.token === 'string' ? body.token : undefined);
    sendJson(response, 200, await withProxyUrl(state, proxy, cloudflare, 'manager'));
    return;
  }
  /*
   * Whether the terms in force are the ones this installation agreed to.
   *
   * The documents ship compiled into the program, so the manager that has just
   * been updated is the one holding a revision its reader has never seen - and
   * nothing about that is visible from inside the console. The revision on
   * record is compared with the one the program carries, and the console is
   * told whether to ask.
   */
  if (pathname === '/api/v1/legal' && method === 'GET') {
    sendJson(response, 200, legalReview(await store.getPersisted()));
    return;
  }
  /*
   * The answer to that question, which is a signature rather than a setting.
   *
   * The revision has to be named, and has to be the one in force. A console
   * left open across an update is showing a card about the revision it loaded
   * with; accepting a name this program no longer carries would record an
   * acknowledgement of wording nobody was shown.
   */
  if (pathname === '/api/v1/legal/acknowledge' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || body.accepted !== true) {
      sendError(response, 400, 'notice_acceptance_required', 'The revised terms must be accepted');
      return;
    }
    if (body.revision !== TERMS_VERSION) {
      sendError(response, 409, 'notice_revision_stale', 'That is not the revision in force; reload the console and read it again');
      return;
    }
    await store.acknowledgeNotice(TERMS_VERSION);
    logger(logEvent('legal.acknowledged', `[manager] the terms in force since ${TERMS_VERSION} were acknowledged`, { revision: TERMS_VERSION }));
    sendJson(response, 200, legalReview(await store.getPersisted()));
    return;
  }
  /*
   * What the manager does with SillyTavern when it starts.
   *
   * One switch, in its own route rather than folded into SillyTavern's own
   * settings: those are written into the runtime's config.yaml and belong to
   * the version installed, and this one belongs to the manager and outlives
   * every version it installs.
   */
  if (pathname === '/api/v1/startup' && method === 'GET') {
    const state = await store.getPersisted();
    sendJson(response, 200, { startup: { autoStartSillyTavern: state.autoStartSillyTavern } satisfies StartupSettings });
    return;
  }
  if (pathname === '/api/v1/startup' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.autoStartSillyTavern !== 'boolean') {
      sendError(response, 400, 'invalid_input', 'autoStartSillyTavern must be true or false');
      return;
    }
    await store.setAutoStartSillyTavern(body.autoStartSillyTavern);
    sendJson(response, 200, { startup: { autoStartSillyTavern: body.autoStartSillyTavern } satisfies StartupSettings });
    return;
  }
  if (pathname === '/api/v1/system' && method === 'GET') {
    sendJson(response, 200, await system.snapshot());
    return;
  }
  if (pathname === '/api/v1/system/measure' && method === 'POST') {
    system.remeasure();
    sendJson(response, 202, await system.snapshot());
    return;
  }
  /*
   * Everything the console watches on its clock, in one answer.
   *
   * The console used to ask for these four separately, several times a minute,
   * which is four connections for one screenful of state. Reached through a
   * Cloudflare Worker - which is what the console's own fixed address is -
   * every one of those counts against an allowance of a hundred thousand a
   * day, shared with SillyTavern's address and with the backup Worker; the
   * console on its own was spending it in seven hours.
   *
   * The four endpoints it replaces are untouched: something already open
   * against an older panel, or a script somebody wrote, still has them.
   */
  if (pathname === '/api/v1/status' && method === 'GET') {
    // The one request the console makes on a clock, and so the one that says
    // somebody is in front of it. It stops while the page is hidden, which is
    // what makes this a measure of being read rather than of being open.
    activity.seen();
    /*
     * Which also makes it the place to go and look at who holds the account.
     *
     * The claim is otherwise read on the way into a write, and a manager with
     * nothing to send never writes - so a machine that had the account taken
     * from it could sit there for hours believing it still had one. Somebody
     * in front of the console is exactly the case worth spending a read on,
     * and it is one small object every few minutes against a free allowance
     * of millions. Not waited for: the answer lands in the next poll, and
     * this one is the console's clock.
     */
    void r2.refreshClaim({ atMostEvery: CLAIM_LOOK_MS }).catch(() => undefined);
    // Read once for the two things below it, both of which come off it.
    const r2Now = await r2.getConfig();
    const status: ConsoleStatus = {
      process: supervisor.getState(),
      tunnel: await withProxyUrl(tunnel.getState(), proxy, cloudflare, 'sillyTavern'),
      managerTunnel: await withProxyUrl(managerTunnel.getState(), proxy, cloudflare, 'manager'),
      security: await decorateSecurity(gateway.getState()),
      // All read from memory, so they cost this answer nothing.
      install: jobs.activeInstallation(),
      operation: jobs.activeOperation(),
      ports: { port: ports.sillyTavern(), reserved: { manager: ports.manager, access: ports.access } },
      r2Owner: r2Now.owner,
      r2Problem: r2Now.cloudflare?.problem ?? null,
    };
    /*
     * And the address this console is being read at, which is how the manager
     * learns where it is without anybody writing it down.
     *
     * On a platform that hands out a URL, that URL is in this request - the
     * console already knows it well enough to say "you are reading this at
     * <address>" when it offers a link of its own, and this is the same
     * knowledge put to the other use. It is learned here rather than from any
     * request because this one carries a session: what teaches the manager its
     * address is a reader's browser, not whoever can reach the port with a
     * `Host` header of their choosing.
     */
    online.seen(keepableOrigin(requestOrigin(context), [
      status.managerTunnel.url,
      managerTunnel.getState().url,
      // The Worker's own address, whether or not it is the one being served
      // right now: a Worker pointing at a tunnel from before this one is still
      // an address a reader can arrive at, and still one to leave alone.
      await proxy?.urlFor('manager') ?? null,
    ]));
    sendJson(response, 200, status);
    return;
  }
  if (pathname === '/api/v1/jobs/active' && method === 'GET') {
    sendJson(response, 200, { job: jobs.activeOperation() });
    return;
  }
  const jobCancelMatch = /^\/api\/v1\/jobs\/([^/]+)\/cancel$/u.exec(pathname);
  if (jobCancelMatch && method === 'POST') {
    const id = jobCancelMatch[1] ?? '';
    if (!jobs.get(id)) { sendError(response, 404, 'job_not_found', 'Job not found'); return; }
    if (!jobs.cancel(id)) { sendError(response, 409, 'job_not_running', 'That job has already finished'); return; }
    sendJson(response, 200, jobs.get(id));
    return;
  }
  const jobMatch = /^\/api\/v1\/jobs\/([^/]+)$/u.exec(pathname);
  if (jobMatch && method === 'GET') {
    const job = jobs.get(jobMatch[1] ?? '');
    if (!job) { sendError(response, 404, 'job_not_found', 'Job not found'); return; }
    sendJson(response, 200, job);
    return;
  }
  if (PROTECTED_PATHS.has(pathname)) {
    sendError(response, 501, 'not_implemented', 'This manager feature is not available in Batch 3');
    return;
  }
  sendError(response, 404, 'not_found', 'Route not found');
}

/**
 * A tunnel's state with the fixed address in front of it attached.
 *
 * Null rather than absent when there is no Worker, so a panel can tell "no
 * fixed address" from "this manager does not know about them".
 *
 * `proxyPending` answers the question the address alone cannot: is what the
 * console would show right now the address this reader is going to keep? It is
 * not, from the moment a tunnel announces itself until the Worker in front of
 * it has been redeployed at the new address - seconds during which the tunnel's
 * own address is about to be replaced and the Worker's still points at the
 * tunnel from last time. Expected is decided the same way the redeploy itself
 * decides it, by asking whether there is a Cloudflare account to deploy into,
 * so the console never waits for an address that is not coming.
 *
 * A publish that failed ends the wait too, and that is the whole of the third
 * case here. Deploying is best effort and the tunnel works without it, but a
 * console that was never told simply went on saying the address was coming -
 * for as long as the manager ran, on top of a tunnel address that worked. So a
 * target whose last publish failed at the tunnel that is up is reported with
 * no fixed address at all: not pending, and `proxyUrl` null rather than a
 * Worker still pointing at some earlier tunnel, which would be a deployed
 * address that answers with an error. Everything downstream then falls back to
 * the tunnel's own address, which is the address there is.
 */
async function withProxyUrl(state: TunnelState, proxy: ProxyWorkerManager | null, cloudflare: CloudflareConnection | null, target: ProxyWorkerTarget): Promise<TunnelState> {
  if (!proxy) return { ...state, proxyUrl: null, proxyPending: false };
  /*
   * A fixed address is an address only while something is behind it.
   *
   * The Worker outlives the tunnel on purpose - that is what makes the
   * address permanent - and it says so politely when there is no tunnel
   * there. But the console went on listing it under "Remote, any device",
   * with a link and a QR code, on a card whose own heading said Offline. Turn
   * the tunnel off, hand somebody the code, and what their phone gets is a
   * page explaining that there is nothing here. It is the tunnel being off
   * that they need to be told, and this is where that is known.
   */
  if (state.mode === 'off') return { ...state, proxyUrl: null, proxyPending: false };
  const record = await proxy.recordFor(target).catch(() => null);
  const expected = cloudflare ? await cloudflare.workersAccount().catch(() => null) !== null : false;
  // A tunnel with no address of its own has nothing for a Worker to follow:
  // it is off, still starting, or a Named Tunnel, which has its own hostname.
  const behind = record?.origin !== state.url;
  const stalled = state.url !== null && proxy.failedOrigin(target) === state.url;
  if (behind && stalled) return { ...state, proxyUrl: null, proxyPending: false };
  /*
   * Behind, not failed, and nothing is on its way to fix it.
   *
   * Then nobody is going to: a redeploy is started by the tunnel announcing an
   * address, and an announcement that was missed is never made again. The
   * console had no way to tell that from a deploy still running, so it waited
   * for a fixed address that was not coming - on top of a tunnel address that
   * worked perfectly - until somebody turned the tunnel off and on, which is
   * the gesture that happens to produce another announcement.
   *
   * So the wait repairs itself. This is the one place that knows both halves:
   * what the tunnel is saying and what was last deployed. It is asked on the
   * console's own clock, which is why the publish it starts checks first
   * whether it has anything to do.
   */
  if (behind && state.url !== null && expected && !proxy.publishing(target)) void proxy.republish(target, state.url);
  /*
   * And no address at all when there is no longer an account behind it.
   *
   * A Worker deployed while this manager held the account goes on answering
   * after another machine signs in with it - at that machine's tunnel, since
   * taking the account is followed by deploying over the same two Workers. So
   * the address this console remembers is not this console's address any
   * more, and it was still being handed out, put in QR codes and published by
   * a manager that had been locked out of the account it names. It is the
   * tunnel's own address from here until somebody signs in again.
   */
  return { ...state, proxyUrl: expected ? record?.url ?? null : null, proxyPending: expected && state.url !== null && behind };
}

/** What starting an installation needs, whoever asked for it. */
interface InstallationDeps {
  readonly runtime: RuntimeManager;
  /** Where the usage log is, so a recovered machine gets its history back too. */
  readonly metrics: MetricsStore;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly system: SystemStore;
}

/**
 * Queue an installation and everything that has to happen around one.
 *
 * Its own function because there are two ways in now: somebody pressing
 * Install, and a manager that has just had its password set and has nothing
 * installed at all. Both need the same safety copy, the same rebinding, the
 * same recovery of an empty profile out of the bucket, and the same restart
 * afterwards - and a second copy of that would be a second chance to get one
 * of them wrong.
 *
 * Throws RuntimeError when an installation is already in flight; the caller
 * decides what that means for its own answer.
 */
async function beginInstallation(deps: InstallationDeps, selector: VersionSelector): Promise<{ installationId: string; job: Job }> {
  const { runtime, jobs, supervisor, profiles, backups, r2, system } = deps;
  const previousProfile = await profiles.getActive();
  const previousInstallation = await runtime.getActiveInstallation();
  let queuedId = '';
  let queued: { id: string; promise: Promise<Installation> };
  // Made here rather than by the job registry, because the work has to be
  // handed the signal at the moment it is queued and the job is named after
  // the installation the queue hands back.
  const stopping = new AbortController();
  try {
    /*
     * Stopping SillyTavern and copying the profile happen inside the job,
     * not inside this request.
     *
     * They used to run before the response was written, so a 202 meaning
     * "accepted, watch the progress" did not arrive until a full copy of the
     * profile had been written to disk - minutes, on a large one, with the
     * panel holding its confirmation dialog open and nothing on screen
     * saying a backup was being taken. The order of the work is unchanged;
     * only the reply no longer waits for it.
     */
    queued = runtime.queueInstall(
      selector,
      (progress) => jobs.updateFromProgress(queuedId, progress),
      async (report) => {
        await supervisor.stop('install');
        if (!previousProfile) return;
        await report(4, logEvent('install.safetyCopy', 'Copying your data before switching version'));
        await backups.createSafetyCopy(previousProfile, { kind: 'before-switch' });
      },
      stopping.signal,
    );
  } catch (error: unknown) {
    await supervisor.start().catch(() => supervisor.getState());
    throw error;
  }
  queuedId = queued.id;
  const job = jobs.create(queued.id, stopping);
  void queued.promise.then(async (installation) => {
    jobs.finish(queued.id, installation.status === 'ready' ? 'succeeded' : 'failed', installation.error);
    /*
     * Stopped, and put back the way it was found.
     *
     * The runtime has already taken out whatever this attempt wrote. What is
     * left is not to go on as if it had finished: no rebinding, no profile
     * recovered into an installation that does not exist, and SillyTavern
     * started again only when there was one before this to start.
     */
    if (installation.errorCode === INSTALL_CANCELED) {
      if (previousInstallation) await supervisor.start().catch(() => supervisor.getState());
      return;
    }
    if (installation.status === 'ready') {
      if (previousProfile) await profiles.rebind(previousProfile.id, installation.id, installation.runtimePath);
      else {
        // A first install on a machine that starts empty every time. If the
        // bucket holds what this machine used to have, it goes back now,
        // before SillyTavern is started on an empty profile.
        // The profile is made inside, so the slot is held before it exists
        // and the scheduler cannot find it half-restored.
        await recoverEmptyProfile(() => profiles.ensureDefault({ installationId: installation.id, runtimePath: installation.runtimePath }), r2, backups, jobs, deps.metrics.filePath);
      }
      await runtime.cleanupLegacyRuntimeCopies?.(installation.id);
      // There is a profile now where a moment ago there was none, and on the
      // overview its size is the line somebody who has just installed is
      // watching. Walked now rather than on whatever poll next falls due.
      system.remeasure();
    }
    await supervisor.start();
  }).catch(async (error: unknown) => {
    jobs.finish(queued.id, 'failed', error instanceof Error ? error.message : 'Installation failed');
    // Putting SillyTavern back is best effort: this path only runs because
    // something already failed, and a second failure inside it rejected with
    // nobody listening - which ends the manager process and takes the console
    // down with it, leaving no way to install a different version.
    await supervisor.start().catch(() => supervisor.getState());
  });
  return { installationId: queued.id, job };
}

/** Each apply-phase step gets its own percentage so a slow phase still shows the bar moving. */
const RESTORE_STEP_PROGRESS: Record<string, number> = {
  'restore.restoringFiles': 85,
  'restore.removingObsolete': 87,
  'restore.finalizing': 88,
};

/**
 * A restore was stopped partway and could not be put back the way it was.
 *
 * The one outcome of a stop that leaves the profile mixed, so it is reported
 * as a failure even though the operator asked for the stop.
 */
export class RestoreRollbackError extends Error {
  public constructor(reason: string) {
    super(`The restore was stopped, and the data could not be put back as it was: ${reason}`);
    this.name = 'RestoreRollbackError';
  }
}

/**
 * Stop SillyTavern, take the safety copy, restore, and start it again.
 *
 * Stopped before any file is written, there is nothing to undo: the safety
 * copy is abandoned and the profile is untouched. Stopped while files are
 * being written, the profile is part old and part new, so the safety copy is
 * restored over it before SillyTavern comes back - a stop always leaves the
 * data the way it was before Restore was pressed. That undo is not itself
 * stoppable; stopping it would leave exactly the mixture it exists to remove.
 */
export async function restoreWithProcess(options: {
  readonly profile: Awaited<ReturnType<ProfileStore['getActive']>> & {};
  readonly backups: BackupStore;
  readonly archivePath: string;
  /**
   * Which archive in the library this is, when it is one.
   *
   * The safety copy taken a moment from now sweeps the library, and the sweep
   * keeps one safety copy: restoring the copy from before the previous restore
   * therefore deleted the file this is about to read. Named here, it is held
   * until the restore is done with it. An uploaded zip on its way through has
   * no entry to hold.
   */
  readonly backupId?: string;
  readonly mode: 'merge' | 'replace';
  /** The reader has been shown what is wrong with this archive and said to go ahead. */
  readonly force?: boolean;
  readonly supervisor: ProcessSupervisor;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number, step: LogEvent) => void;
}): Promise<{ preview: Awaited<ReturnType<BackupStore['restore']>>; safetySnapshot: Awaited<ReturnType<BackupStore['create']>>; process: ReturnType<ProcessSupervisor['getState']> }> {
  const { profile, backups, archivePath, mode, supervisor, signal, onProgress } = options;
  const releaseArchive = options.backupId ? backups.hold(options.backupId) : () => undefined;
  // Claim the backup store before stopping anything. Otherwise the scheduler's
  // next tick sees an idle store and starts a full backup that the restore then
  // has to wait out.
  const releaseOperationSlot = backups.reserve();
  onProgress?.(5, logEvent('job.stoppingSillyTavern', 'Stopping SillyTavern'));
  await supervisor.stop('restore');
  let safetyCopy: Awaited<ReturnType<BackupStore['create']>> | null = null;
  let writing = false;
  try {
    // A safety copy has to exist before the restore overwrites anything, but it
    // does not have to be a second copy of every file. Writing one compressed
    // archive is a single large sequential write; copying the tree file by file
    // measured 639 seconds on a hosted network volume for the same data. It only
    // An unchanged profile can reuse the backup it already has.
    onProgress?.(15, logEvent('job.creatingSafetySnapshot', 'Creating safety snapshot'));
    const safetySnapshot = safetyCopy = await backups.createSafetyCopy(profile, {
      kind: 'before-restore',
      ...(signal ? { signal } : {}),
      onProgress: ({ completed, total }) => onProgress?.(15 + (total > 0 ? (completed / total) * 10 : 0), logEvent('job.backingUpCurrentData', `Backing up current data (${completed}/${total})`, { completed, total })),
    });
    onProgress?.(25, logEvent('job.restoringData', 'Restoring data'));
    writing = true;
    const preview = await backups.restore(profile, archivePath, {
      mode,
      ...(options.force ? { force: true } : {}),
      ...(signal ? { signal } : {}),
      onProgress: ({ completed, total }) => onProgress?.(25 + (total > 0 ? (completed / total) * 60 : 60), logEvent('job.restoringFiles', `Restoring files (${completed}/${total})`, { completed, total })),
      onStatus: (step) => onProgress?.(RESTORE_STEP_PROGRESS[step.code] ?? 86, step),
    });
    onProgress?.(90, logEvent('job.startingSillyTavern', 'Starting SillyTavern'));
    const process = await supervisor.start();
    onProgress?.(100, logEvent('job.restoreComplete', 'Restore complete'));
    return { preview, safetySnapshot, process };
  } catch (error) {
    // Nothing was written, or what was written has been put back: the profile
    // is what the safety copy holds, so the copy is no longer a safety copy.
    const settle = async () => { if (safetyCopy) await backups.reclassifyAsScheduled(safetyCopy.id).catch(() => undefined); };
    if (!writing) await settle();
    if (writing && signal?.aborted && safetyCopy) {
      try {
        onProgress?.(88, logEvent('job.rollingBack', 'Putting the data back as it was before the restore'));
        const safetyPath = await backups.getArchivePath(safetyCopy.id);
        if (!safetyPath) throw new Error('the safety copy is missing');
        // The undo, never refused: this archive is the profile as it stood a
        // moment ago, and whatever it holds is what the reader is owed back.
        await backups.restore(profile, safetyPath, { mode: 'replace', force: true });
        await settle();
      } catch (rollbackError: unknown) {
        await supervisor.start().catch(() => supervisor.getState());
        throw new RestoreRollbackError(rollbackError instanceof Error ? rollbackError.message : 'unknown error');
      }
    }
    await supervisor.start().catch(() => supervisor.getState());
    throw error;
  } finally {
    releaseArchive();
    releaseOperationSlot();
  }
}

/**
 * Where SillyTavern keeps the reader's own files inside a profile.
 *
 * A profile written in the canonical layout holds them under default-user; the
 * legacy public/ layout is already that root itself.
 */
/**
 * An image the reader already owns, sent back to their own browser.
 *
 * Kept for a few minutes: it is their wallpaper and their character cards,
 * which do not change while they are looking at the overview, and re-reading
 * a megabyte off the disk on every visit to the page buys nothing.
 */
function sendImage(response: ServerResponse, image: { bytes: Buffer; contentType: string }): void {
  response.writeHead(200, {
    'content-type': image.contentType,
    'content-length': image.bytes.byteLength,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  response.end(image.bytes);
}

function userDataRoot(profile: Profile): string {
  return profile.layout === 'data' ? join(profile.dataPath, 'default-user') : profile.dataPath;
}

function cloudflareConnectionFromEnvironment(paths: PlatformPaths, env: NodeJS.ProcessEnv): CloudflareConnection | null {
  const clientId = (env.STM_CLOUDFLARE_OAUTH_CLIENT_ID ?? DEFAULT_CLOUDFLARE_CLIENT_ID).trim();
  if (!clientId) return null;
  const redirectUri = env.STM_CLOUDFLARE_OAUTH_REDIRECT_URI?.trim() || DEFAULT_CLOUDFLARE_REDIRECT_URI;
  const scopes = env.STM_CLOUDFLARE_OAUTH_SCOPES?.split(/[\s,]+/u).filter(Boolean) ?? Object.values(DEFAULT_SCOPES);
  return new CloudflareConnection({ paths, client: { clientId, redirectUri, scopes } });
}

/**
 * Connect, choose an account, disconnect, and read where things stand.
 *
 * Whatever changes the connection also says what backups use: connecting makes
 * the signed-in bucket the one backed up to, and disconnecting it switches R2
 * backups off rather than leaving them failing on a schedule.
 */
async function handleCloudflareRequest(context: RequestContext, cloudflare: CloudflareConnection | null, r2: R2Manager, proxy: ProxyWorkerManager | null, publishProxies: () => void, logger: LogSink, handoffs: HandoffStore): Promise<void> {
  const { pathname, request, response } = context;
  const method = request.method ?? 'GET';
  if (!cloudflare) { sendError(response, 404, 'cloudflare_not_available', 'This manager has no Cloudflare sign-in configured'); return; }
  if (pathname === '/api/v1/r2/cloudflare' && method === 'GET') {
    sendJson(response, 200, { cloudflare: await cloudflare.status() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/connect' && method === 'POST') {
    const returnOrigin = panelOrigin(context);
    if (!returnOrigin) { sendError(response, 400, 'invalid_origin', 'The panel origin could not be read'); return; }
    // Named here so the callback can find its way back to this session even
    // when the browser returns to a window that carries none; see beginConnect.
    const url = cloudflare.beginConnect(returnOrigin, 'connect', context.sessionToken);
    sendJson(response, 200, { url, ...openHandoff(context, handoffs, url) });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/buckets' && method === 'GET') {
    // The account's buckets, so the panel can offer them rather than ask the
    // user to type a name that has to match one exactly.
    sendJson(response, 200, { buckets: await cloudflare.listBuckets() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/bucket' && method === 'POST') {
    const body = await readJson(request);
    const name = isRecord(body) && typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { sendError(response, 400, 'invalid_bucket', 'A bucket name is required'); return; }
    const status = await cloudflare.chooseBucket(name);
    if (status.state === 'connected') await claimForThisMachine(r2, logger);
    sendJson(response, 200, { cloudflare: status, config: await r2.getConfig() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/account' && method === 'POST') {
    const body = await readJson(request);
    const accountId = isRecord(body) && typeof body.accountId === 'string' ? body.accountId : '';
    if (!/^[0-9a-f]{32}$/u.test(accountId)) { sendError(response, 400, 'invalid_account', 'A Cloudflare account ID is required'); return; }
    const status = await cloudflare.chooseAccount(accountId, await r2.keysBucket());
    if (status.state === 'connected') {
      await r2.update({ mode: 'cloudflare', enabled: true });
      await claimForThisMachine(r2, logger);
      // There is somewhere to put the fixed addresses now. Not waited for: a
      // deploy takes seconds and the reader is waiting to see their account
      // connected, not to see two Workers appear.
      publishProxies();
    }
    sendJson(response, 200, { cloudflare: status, config: await r2.getConfig() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/disconnect' && method === 'POST') {
    /*
     * The Workers go before the grant does, because afterwards there is no
     * grant to remove them with.
     *
     * Signing out has to leave nothing of ours behind in somebody's account -
     * a Worker nobody can explain, still answering on their own subdomain, is
     * the worst thing to find there. Best effort all the same: a removal that
     * fails must not stop the sign-out the reader asked for, and the Worker
     * that is left is one they can delete in the dashboard.
     */
    const account = proxy ? await cloudflare.workersAccount().catch(() => null) : null;
    if (proxy && account) {
      for (const target of PROXY_WORKER_TARGETS) {
        await proxy.remove(account.id, target).catch((error: unknown) => {
          logger(logEvent('cloudflare.proxyRemoveFailed', `[cloudflare] a fixed address Worker could not be removed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
          return false;
        });
      }
    }
    // The claim in the bucket goes first, while there is still a grant to
    // reach the bucket with. Left behind, the next machine to connect would
    // have to argue with a claim nobody is behind any more.
    await r2.releaseOwnership().catch((error: unknown) => {
      logger(logEvent('r2.claimReleaseFailed', `[r2] the bucket claim could not be given up: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    });
    const result = await cloudflare.disconnect();
    await proxy?.forget().catch(() => undefined);
    if ((await r2.getConfig()).mode === 'cloudflare') await r2.update({ enabled: false });
    sendJson(response, 200, { ...result, config: await r2.getConfig() });
    return;
  }
  sendError(response, 404, 'not_found', 'Route not found');
}

/**
 * Where the browser lands after Cloudflare, straight or through the relay.
 *
 * It is a page load, not an API call, so it answers with a redirect to the
 * panel carrying the outcome. The session cookie is `SameSite=Lax`, which a
 * top-level navigation back from Cloudflare still carries, so only a signed-in
 * admin can finish connecting this manager.
 */
async function handleCloudflareCallback(context: RequestContext, sessions: SessionStore, cloudflare: CloudflareConnection | null, r2: R2Manager, publishProxies: () => void, logger: LogSink, handoffs: HandoffStore, signIn: CloudflareSignInDeps): Promise<void> {
  const { response, searchParams } = context;
  const state = searchParams.get('state') ?? '';
  /*
   * Whether a console is waiting to collect this, rather than reading it here.
   *
   * It decides both halves of the answer: the result is left where that
   * console can fetch it, and the page this redirects to is told it is a
   * window to be closed rather than a console to become. Said in the address
   * because the address is the one thing that survives the trip - the window
   * comes back from Cloudflare with its opener severed and its storage in a
   * different partition, and can no longer tell what it is on its own.
   */
  const collected = handoffs.isOpen(state);
  const redirect = (outcome: string, code?: string, page = '#data', sessionToken: string | null = null): void => {
    if (collected) handoffs.settle(state, { outcome, code: code ?? '', sessionToken });
    const query = new URLSearchParams({
      cloudflare: outcome,
      ...(code ? { cloudflare_error: code } : {}),
      ...(collected ? { handoff: '1' } : {}),
    });
    response.writeHead(303, {
      location: `/?${query.toString()}${page}`,
      'cache-control': 'no-store',
      // The address this was reached at holds the authorization code.
      'referrer-policy': 'no-referrer',
    });
    response.end();
  };
  if (!cloudflare) { redirect('error', 'cloudflare_not_available'); return; }
  /*
   * A sign-in is finished without a session, because not having one is what it
   * is for. Which of the two this is was decided when it was started, and is
   * held in this process - not in the state Cloudflare hands back, which a
   * browser could edit.
   */
  const purpose = cloudflare.pendingPurpose(state);
  if (purpose === 'signIn') {
    await completeCloudflareSignIn(context, sessions, cloudflare, r2, logger, signIn, redirect);
    return;
  }
  /*
   * Nothing at all is waiting on this state: a sign-in that already finished,
   * a page reloaded out of history, or one left open past its ten minutes.
   * Saying "sign in first" to somebody who has just come back from Cloudflare
   * is the one answer that cannot be acted on; what happened is that this
   * particular sign-in is no longer the one to finish.
   */
  if (!purpose && !sessions.get(context.sessionToken)) { redirect('error', 'cloudflare_state_mismatch'); return; }
  /*
   * Whoever started this, rather than whoever is standing here.
   *
   * Cloudflare will not load inside a frame, so a framed console sends the
   * reader to a window of its own - which is a different place for cookies
   * than the frame is. The browser coming back can therefore hold no session
   * while the console that sent it is still signed in, and answering "sign in
   * first" to somebody who never signed out is the one reply that cannot be
   * acted on. The session is taken from the sign-in this callback belongs to,
   * which is held here and not in anything the browser can edit.
   */
  const startedBy = cloudflare.pendingStartedBy(state);
  const connecting = startedBy && sessions.get(startedBy) ? startedBy : context.sessionToken;
  if (!sessions.get(connecting)) { redirect('error', 'login_required'); return; }
  try {
    const status = await cloudflare.completeConnect({
      state,
      code: searchParams.get('code'),
      error: searchParams.get('error'),
      errorDescription: searchParams.get('error_description'),
    }, await r2.keysBucket());
    if (status.state === 'connected') {
      await r2.update({ mode: 'cloudflare', enabled: true });
      /*
       * And this machine becomes the one that backs up, because signing in is
       * what decides that.
       *
       * The claim used to be taken only where the reader picked an account
       * from a list. A sign-in that settles the account by itself - the grant
       * reaches exactly one, or it is a reconnect to the one already chosen -
       * came back connected and took nothing, so a machine reconnecting to an
       * account another machine had taken sat there refused by a claim it had
       * just out-signed-in. The rule is the same in both cases: whoever signed
       * in last holds it.
       */
      await claimForThisMachine(r2, logger);
      // There is somewhere to put the fixed addresses again. Not waited for:
      // the reader is waiting on a redirect, not on two Workers.
      publishProxies();
    }
    redirect(status.state);
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'cloudflare_connect_failed';
    logger(logEvent('r2.cloudflareConnectFailed', `[r2] connecting to Cloudflare failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    redirect('error', code);
  }
}

/**
 * Put a blank machine back together, after its owner signed in.
 *
 * Three things, in the order they depend on each other. The settings first,
 * because they carry the password that opens SillyTavern and the schedules
 * everything after this runs on. Then the bucket, which may still be claimed
 * by the installation this machine used to be - it has no disk any more, so
 * the claim it left is not protecting anything, and taking it is the only way
 * a host that is wiped repeatedly ever backs up again. Then the profile.
 *
 * Every step is allowed to fail on its own. A machine that gets its settings
 * back and not its chats is better off than one that gets neither, and the
 * console shows what happened.
 */
interface RestoreAfterSignInDeps {
  readonly store: StateStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly runtime: RuntimeManager;
  readonly jobs: JobStore;
  readonly profiles: ProfileStore;
  readonly gateway: AccessGateway;
  readonly metrics: MetricsStore;
  readonly tunnel: TunnelManager;
  readonly managerTunnel: TunnelManager;
  readonly ports: ServerPorts;
  /** Put SillyTavern on a machine that has none, as a first run does. */
  readonly firstInstall: (wanted?: string | null) => Promise<void>;
  /** Move the running manager onto the port the settings brought back. */
  readonly adoptSillyTavernPort: (port: number) => Promise<void>;
  /** Tell the running manager what the settings say about keeping it online. */
  readonly adoptKeepOnline: (enabled: boolean, minutes: number) => void;
  /** Stops SillyTavern around a restore that writes over a profile in use. */
  readonly supervisor: ProcessSupervisor;
  /**
   * Somebody pressed Restore everything, rather than this being a sign-in.
   *
   * The automatic path is deliberately timid: it applies settings only where
   * this machine has none, and brings data back only into a profile that holds
   * nothing. That is right when nobody asked - it cannot take away anything
   * somebody has.
   *
   * A press is somebody asking, in front of a card that says what it will do.
   * Then the settings go back whatever this machine has of its own, the
   * release the bucket remembers is installed even if another one is here
   * already, and the newest recovery point is put into the profile - through
   * the ordinary restore, which stops SillyTavern and takes a safety copy
   * first, so what was here is still in the backup library afterwards.
   */
  readonly force?: boolean;
  readonly logger: LogSink;
}

async function restoreAfterSignIn(deps: RestoreAfterSignInDeps): Promise<void> {
  const { store, backups, r2, runtime, jobs, gateway, tunnel, managerTunnel, adoptSillyTavernPort, adoptKeepOnline, logger } = deps;
  const settings = { store, backups, r2, runtime, tunnel, managerTunnel, gateway, adoptSillyTavernPort, adoptKeepOnline, logger };
  /*
   * Opened first, before a single question is asked of the bucket.
   *
   * The console is being reloaded onto the Overview at this exact moment, and
   * what it found there was a card saying SillyTavern is not installed with an
   * Install button on it - live, for the seconds it takes to read the settings
   * and decide. Somebody who signed in precisely so that their machine would
   * put itself back together is the most likely person in the world to press
   * it, and pressing it starts a second install beside the one about to begin.
   *
   * So the work exists before anything can be pressed. The job is what the
   * console reads to grey the button out and say what is happening instead,
   * and it stays open across the whole sign-in: reading the settings, taking
   * the bucket, and - where there is a profile to fill - the download itself.
   */
  const running = jobs.createOperation('r2Fetch', logEvent('job.checkingAccount', 'Checking this account for data to bring back'));
  let failure: string | null = null;
  try {
    await bringThisMachineBack(deps, settings, running);
  } catch (error: unknown) {
    failure = error instanceof Error ? error.message : 'This machine could not be brought back';
    throw error;
  } finally {
    jobs.finishOperation(running.job.id, failure === null ? 'succeeded' : 'failed', failure);
  }
}

/**
 * The sign-in recovery itself, inside the job that reports it.
 *
 * Split out only so that the job above is closed whichever way this leaves -
 * including the early return on a machine with nothing installed, where the
 * install job takes over the reporting from here.
 */
async function bringThisMachineBack(
  deps: RestoreAfterSignInDeps,
  settings: ManagerSettingsDeps,
  running: { readonly job: Job; readonly signal: AbortSignal },
): Promise<void> {
  const { r2, backups, jobs, profiles, metrics, ports, logger } = deps;
  /*
   * The bucket first, before anything needs to write to it.
   *
   * It may be claimed by whatever this machine used to be - the claim lives in
   * the bucket precisely so that it outlives the disk - or by a different
   * machine on the same account. Either way the person who just signed in
   * holds the account and is sitting in front of this one, which is the whole
   * of the argument.
   */
  await claimForThisMachine(r2, logger);
  const restored = await restoreSettings(deps, settings).catch((error: unknown) => {
    logger(logEvent('r2.settingsRestoreFailed', `[r2] the settings in the bucket could not be applied: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    return null;
  });
  if (restored) {
    /*
     * The usage history, which is not part of a recovery point and so comes
     * back on its own.
     *
     * Only onto a machine whose own log is still empty - the log is
     * append-only and this writes the bucket's copy over it - and here rather
     * than only with the profile below, because on a machine with nothing
     * installed there is no profile to recover into and that step never runs.
     * A machine put back together with months of chats and a metrics page
     * reading zero looks like a restore that half worked.
     */
    if (deps.force || await metricsFileIsEmpty(metrics.filePath)) {
      await r2.restoreMetricsFile(metrics.filePath).catch((error: unknown) => {
        logger(logEvent('r2.metricsRecoveryFailed', `[r2] the usage history could not be brought back: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
        return null;
      });
    }
    // Now that the bucket is this machine's, the record in it can be. The
    // attempt inside the restore itself came before the takeover and will have
    // been refused; this is the one that lands, and it is what stops the
    // console offering a machine its own settings back.
    await saveManagerSettings(settings).catch(() => false);
  }
  const profile = await profiles.getActive();
  /*
   * Nothing installed yet, which is every machine that has just signed in on a
   * host that starts from the checkout.
   *
   * A profile is made against an installation, so there is nothing to recover
   * into until there is one - and installing is what produces it. The install
   * does the recovery itself when it finishes, the same way a first install
   * after the password screen does, and the console follows it as an ordinary
   * job. That is also the answer to a sign-in which showed one line in the log
   * and nothing else while the reader sat waiting for something to happen.
   */
  if (!profile) { await deps.firstInstall(restored?.record.versionRef); return; }
  /*
   * A press, onto a machine that already has an installation and a profile.
   *
   * The automatic path stops here - it writes only into an empty profile - and
   * stopping here is exactly what somebody pressing Restore everything did not
   * want.
   *
   * Which of the two things they get depends on what is already here. A
   * machine running a different release than the bucket remembers is
   * reinstalled onto that release, and installing makes a profile of its own,
   * which is empty, which the install then fills from the bucket - the whole
   * of the press in the path that already existed. A machine already on the
   * right release only needs the data, so the newest recovery point goes in
   * through the ordinary restore: SillyTavern stopped, a safety copy of what
   * is here taken, and the point put in its place.
   */
  if (deps.force) {
    const wanted = restored?.record.versionRef ?? null;
    const active = await deps.runtime.getActiveInstallation();
    if (wanted && active?.resolvedRef !== wanted) { await deps.firstInstall(wanted); return; }
    await refillProfile(deps, profile, running);
    return;
  }
  await recoverEmptyProfile(() => Promise.resolve(profile), r2, backups, jobs, metrics.filePath, running);
}

/**
 * The settings in the bucket, applied as far as this run is allowed to.
 *
 * A sign-in applies them only onto a machine that has none of its own; a press
 * applies them whatever this machine has, because that is what the press said.
 * Either way what comes back is reported, because it carries more than was
 * applied: which release this machine was running is not a setting to write
 * down, it is a thing to go and install.
 */
async function restoreSettings(
  deps: RestoreAfterSignInDeps,
  settings: ManagerSettingsDeps,
): Promise<{ readonly applied: readonly string[]; readonly record: ManagerSettingsRecord } | null> {
  const ports = { manager: deps.ports.manager, access: deps.ports.access };
  if (!deps.force) return await restoreFromBucketIfBlank(settings, { ports });
  // The machine the card named, which may be the record kept beside the
  // current one; see `foreignManagerSettings`.
  const record = await foreignManagerSettings(settings);
  if (!record) return null;
  const result = await applyManagerSettings(settings, record, { passwords: true, schedules: true, ports });
  // The gateway is holding the credential and the binding this machine had a
  // moment ago, neither of which is what it has just been told to use.
  const state = await deps.store.getPersisted();
  deps.gateway.setPassword(state.accessPasswordHash, state.accessPasscode);
  await deps.gateway.setLan(state.accessLanEnabled).catch(() => undefined);
  return { applied: result.applied, record };
}

/**
 * Put the newest recovery point over a profile that already has data in it.
 *
 * Only ever from a press. The restore underneath is the one the Data page
 * uses: it stops SillyTavern, takes a safety copy into the backup library, and
 * replaces the profile - so somebody who pressed this having misread the card
 * still has what they had, under Backups.
 */
async function refillProfile(
  deps: RestoreAfterSignInDeps,
  profile: Profile,
  running: { readonly job: Job; readonly signal: AbortSignal },
): Promise<void> {
  const { r2, backups, jobs, supervisor, logger } = deps;
  /*
   * The backup slot is held across the whole of this, fetch included.
   *
   * The scheduler ticks every minute, and a minute into a restore it would
   * find a profile holding whatever had arrived so far and write that to the
   * bucket as a recovery point - which is then the newest one there, and the
   * one the next machine would be given back. A backup of a profile caught
   * mid-restore is worse than no backup: it is the shape of the reader's data
   * with nothing in it.
   *
   * Reserved rather than queued, because the restore below takes the slot
   * itself and waiting for a slot this already holds would wait forever.
   */
  const release = backups.reserve();
  try {
    const newest = (await r2.listSnapshots())[0];
    if (!newest) {
      logger(logEvent('r2.recoveryFailed', '[r2] no recovery point in the bucket could be brought back: the bucket holds none', { reason: 'the bucket holds none' }));
      return;
    }
    const meter = new TransferMeter();
    const { manifest } = await fetchSnapshotToLibrary({
      profile, r2, backups, snapshotId: newest.id, sourceProfileId: newest.profileId, signal: running.signal,
      logger: (line) => jobs.append('backup', line),
      onProgress: (progress) => {
        const { percent, params } = meter.update(progress);
        jobs.updateOperation(running.job.id, percent, logEvent('job.fetchingChunks', `Fetching ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
      },
    });
    const archivePath = await backups.getArchivePath(manifest.id);
    if (!archivePath) throw new Error('the fetched recovery point could not be found in the backup library');
    await restoreWithProcess({
      profile, backups, archivePath, backupId: manifest.id, mode: 'replace', force: true, supervisor,
      signal: running.signal,
      onProgress: (progress, step) => jobs.updateOperation(running.job.id, progress, step),
    });
    await r2.recordRecovery({ createdAt: newest.createdAt, fileCount: manifest.fileCount, sizeBytes: manifest.sizeBytes });
    logger(logEvent('r2.recovered', `[r2] the recovery point from ${newest.createdAt} is back in this profile`, { createdAt: newest.createdAt }));
  } finally {
    release();
  }
}

/**
 * Whether this machine's usage log has nothing in it yet.
 *
 * Asked before the bucket's copy is written over it: the log is append-only,
 * and a restore onto one that has been added to since would throw away
 * whatever was added. A missing file is as empty as a file gets.
 */
async function metricsFileIsEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size === 0;
  } catch {
    return true;
  }
}

/**
 * The machine that just signed in becomes the machine that backs up.
 *
 * Signing in to Cloudflare is proof of holding the account, and the account
 * holder's newest manager is the one they mean: somebody who moved to a new
 * machine has thrown the old one away, and the old one is the one that used to
 * win. It used to take a button, on a console that first had to work out why
 * its backups had stopped - and what it was told was `401 unauthorized`.
 *
 * So it is not asked about any more. The claim in the bucket moves here, the
 * other machine's Worker key goes with it, and that machine finds out at its
 * next check and is told who took it and how to take it back: sign in again,
 * from there.
 *
 * Best effort. A sign-in that worked is not undone by a bucket that could not
 * be written to, and the claim is read before every write anyway.
 */
/**
 * The machine that holds this Cloudflare account, when it is not this one.
 *
 * Read from what the last look at the bucket found rather than by looking
 * again: this is asked on the way into work that would write to the account,
 * and the answer is already on disk. Null is the ordinary case - nobody has
 * taken it, or there is no account.
 */
async function lostTheAccount(r2: R2Manager): Promise<string | null> {
  const owner = (await r2.getConfig()).owner;
  return owner && !owner.mine ? owner.label : null;
}

/**
 * Why nothing can be put back from an account this machine no longer holds.
 *
 * The console has a card offering to rebuild this machine from what the
 * account remembers, and it was still offering it after another machine had
 * taken the account - over settings this manager could no longer read, with a
 * button that failed by saying the account held no settings at all. It holds
 * plenty; they are simply not this machine's to take any more.
 */
function displacedMessage(label: string): string {
  return `${label} signed in with this Cloudflare account, so nothing can be restored from it here. Sign in to Cloudflare again from this machine first.`;
}

async function claimForThisMachine(r2: R2Manager, logger: LogSink): Promise<void> {
  await r2.takeOwnership().catch((error: unknown) => {
    logger(logEvent('r2.takeOwnershipFailed', `[r2] this machine could not take the bucket: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    return null;
  });
}

/** What finishing a Cloudflare sign-in needs beyond the connection itself. */
interface CloudflareSignInDeps {
  readonly store: StateStore;
  readonly backups: BackupStore;
  readonly runtime: RuntimeManager;
  readonly secureCookies: boolean;
  /** The same limiter the sign-in was started against, to give the attempt back. */
  readonly rateLimiter: RateLimiter;
  /** Bring this machine's data and settings back, for one that has neither. */
  readonly restoreEverything: () => Promise<void>;
}

/**
 * Open the console because Cloudflare says who this is.
 *
 * The account that owns this manager is the credential. The first one to sign
 * in claims it - the same rule as the first person to reach a manager with no
 * password being the one who sets it - and after that only that account is let
 * in, so a console exposed to the internet is not a door the next Cloudflare
 * user gets a key to.
 *
 * What makes this worth having is what follows it. A machine that loses its
 * disk every few days has nothing: no password, no profile, no settings, no
 * idea where its backups are. One sign-in gives it all four, without a single
 * question, because everything needed to answer them is in the bucket the
 * account already owns.
 */
async function completeCloudflareSignIn(
  context: RequestContext,
  sessions: SessionStore,
  cloudflare: CloudflareConnection,
  r2: R2Manager,
  logger: LogSink,
  deps: CloudflareSignInDeps,
  redirect: (outcome: string, code?: string, page?: string, sessionToken?: string | null) => void,
): Promise<void> {
  const { searchParams } = context;
  let status;
  try {
    status = await cloudflare.completeConnect({
      state: searchParams.get('state') ?? '',
      code: searchParams.get('code'),
      error: searchParams.get('error'),
      errorDescription: searchParams.get('error_description'),
    }, await r2.keysBucket());
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'cloudflare_connect_failed';
    logger(logEvent('auth.cloudflareFailed', `[auth] signing in with Cloudflare failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    redirect('error', code, '');
    return;
  }
  const account = status.account;
  if (!account) {
    // Cloudflare returned without settling which account this is - more than
    // one was offered and none chosen. There is nobody to let in yet.
    redirect('error', 'cloudflare_account_required', '');
    return;
  }
  const claim = await deps.store.claimCloudflareOwner(account.id, account.name);
  if (!claim.allowed) {
    logger(logEvent('auth.cloudflareRefused', `[auth] a Cloudflare sign-in was refused: this manager belongs to ${claim.owner ?? 'another account'}`, { owner: claim.owner ?? '' }));
    redirect('error', 'cloudflare_not_owner', '');
    return;
  }
  if (status.state === 'connected') await r2.update({ mode: 'cloudflare', enabled: true });
  // Starting the sign-in cost this visitor an attempt; it turned out to be the
  // owner of the manager, so it is given back the same way a password is.
  clearRateLimit(context, deps.rateLimiter);
  const created = sessions.create();
  context.response.setHeader('Set-Cookie', sessionCookie(created.token, deps.secureCookies));
  logger(logEvent('auth.cloudflareSignedIn', `[auth] signed in with the Cloudflare account ${account.name}`, { account: account.name }));
  // Detached: putting a profile back is minutes of downloading, and the reader
  // is waiting on a redirect. The console shows the job like any other.
  void deps.restoreEverything().catch((error: unknown) => {
    logger(logEvent('auth.cloudflareRestoreFailed', `[auth] this machine could not be restored after signing in: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
  });
  // The session goes with it, for a console that is waiting to collect this
  // rather than reading it in its own address; see cloudflare-handoff.ts.
  redirect(status.state === 'connected' ? 'signed_in' : status.state, undefined, '', created.token);
}

/**
 * The revision on record against the revision the program carries.
 *
 * Only the date is compared. The label - `2026.09` - is for a reader; the date
 * is what every installation wrote down when it was set up and what moves when
 * the documents are revised, so it is the one thing on both sides that means
 * the same thing. Not "newer than", simply "different from": a manager rolled
 * back to an older version is showing older wording than the reader agreed to,
 * and that is worth asking about too.
 */
function legalReview(state: { readonly termsVersion: string; readonly noticeAcknowledgedAt: string | null }): LegalReview {
  return {
    required: state.termsVersion !== TERMS_VERSION,
    revision: LEGAL_META.revision,
    effective: TERMS_VERSION,
    accepted: state.termsVersion,
    acknowledgedAt: state.noticeAcknowledgedAt,
  };
}

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.has(pathname)
    || pathname.startsWith('/api/v1/installations/')
    || pathname.startsWith('/api/v1/jobs/')
    || pathname.startsWith('/api/v1/logs')
    || pathname.startsWith('/api/v1/process')
    || pathname.startsWith('/api/v1/profiles/')
    || pathname.startsWith('/api/v1/backups/')
    || pathname.startsWith('/api/v1/r2/')
    || pathname.startsWith('/api/v1/config/');
}

function parseConfigUpdateInput(value: unknown): ConfigUpdateInput {
  if (!isRecord(value)) throw new RequestError(400, 'invalid_input', 'A configuration update is required');
  if (typeof value.rawYaml === 'string') return { rawYaml: value.rawYaml };
  const settings = value.settings;
  if (!isRecord(settings)) throw new RequestError(400, 'invalid_input', 'Configuration settings are required');
  const flags = [
    'lazyLoadCharacters', 'useDiskCache', 'requestCompression',
    'extensions', 'extensionAutoUpdate', 'allowKeysExposure', 'chatBackups',
  ] as const;
  const input: Record<string, unknown> = {};
  for (const flag of flags) if (typeof settings[flag] === 'boolean') input[flag] = settings[flag];
  if (typeof settings.memoryCacheCapacity === 'string') input.memoryCacheCapacity = settings.memoryCacheCapacity;
  if (typeof settings.chatBackupCount === 'number') input.chatBackupCount = settings.chatBackupCount;
  // The values themselves are checked where they are written, so one rule
  // covers the console, a stray API call and a restored profile alike.
  return { settings: input as NonNullable<ConfigUpdateInput['settings']> };
}

async function decorateConfig(document: Awaited<ReturnType<ConfigStore['read']>>): Promise<Awaited<ReturnType<ConfigStore['read']>>> {
  const host = await networkHost();
  return host ? { ...document, networkHost: host } : document;
}

/**
 * How long an answer about this machine's network address is reused.
 *
 * The gateway state below rides on the console's polling clock, and asking
 * the operating system which interface it would leave by opens a socket each
 * time. A laptop carried to another Wi-Fi is on the old answer for at most
 * this long, which is shorter than the walk between two rooms.
 */
const NETWORK_HOST_TTL_MS = 15_000;
let networkHostSeen: { readonly at: number; readonly host: string | null } | null = null;

/**
 * The gateway's state, and where its door can be reached from the network.
 *
 * The console shows that address beside the local network switch and hides
 * the switch entirely without one. It cannot read it off the configuration
 * document, which carries the same address: that document does not exist
 * until SillyTavern is installed, and the switch is on screen before then -
 * so on a machine with a perfectly good Wi-Fi the switch would be refused for
 * the whole of the first visit.
 */
async function decorateSecurity(state: AccessGatewayState): Promise<AccessGatewayState> {
  const now = Date.now();
  if (!networkHostSeen || now - networkHostSeen.at >= NETWORK_HOST_TTL_MS) {
    networkHostSeen = { at: now, host: (await networkHost()) ?? null };
  }
  return { ...state, networkHost: networkHostSeen.host };
}

/**
 * This machine's address on the network around it, or nothing when it has none.
 *
 * The panel asks for it with the configuration; the banner printed at startup
 * asks for it too, and the two must not disagree about which of several
 * adapters is the real one.
 */
export async function networkHost(): Promise<string | undefined> {
  return preferredNetworkHost(Object.values(networkInterfaces()).flatMap((entries) => entries ?? []), await routedAddress());
}

/**
 * The address another device on this network can actually reach.
 *
 * Taking the first non-loopback address found handed out 169.254.83.107 - a
 * link-local address a virtual adapter assigned itself when nothing answered
 * it. Preferring a private range instead handed out 192.168.137.1, the Windows
 * Mobile Hotspot adapter: just as private, and just as useless for reaching
 * this machine from the Wi-Fi everything else is on. Either way the LAN link
 * and the code to scan pointed somewhere unreachable, which looks exactly like
 * the feature not working.
 *
 * So `routed` decides it when it is known: the address of the interface the
 * operating system itself would use to leave this machine, which is the one
 * the phone in the same room shares. The ranges are only the fallback.
 */
export function preferredNetworkHost(entries: ReadonlyArray<{ family: string | number; internal: boolean; address: string }>, routed?: string | undefined): string | undefined {
  const candidates = entries
    .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
    .map((entry) => entry.address)
    // Self-assigned when no address was ever handed out, so nothing routes to it.
    .filter((address) => !address.startsWith('169.254.'));
  if (routed && candidates.includes(routed)) return routed;
  const isPrivate = (address: string): boolean => {
    if (address.startsWith('192.168.') || address.startsWith('10.')) return true;
    const second = Number(address.split('.')[1]);
    return address.startsWith('172.') && second >= 16 && second <= 31;
  };
  return candidates.find(isPrivate) ?? candidates[0];
}

/**
 * Which interface this machine leaves by, without sending anything.
 *
 * Connecting a UDP socket transmits no packet; it only makes the operating
 * system choose the route, and the local address it picked is then readable.
 * Nothing here depends on that address being reachable or even existing.
 */
async function routedAddress(): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (address?: string): void => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve(address && address !== '0.0.0.0' ? address : undefined);
    };
    const timer = setTimeout(() => finish(), 300);
    timer.unref?.();
    socket.once('error', () => finish());
    try {
      socket.connect(53, '8.8.8.8', () => {
        let address: string | undefined;
        try { address = socket.address().address; } catch { /* nothing bound */ }
        clearTimeout(timer);
        finish(address);
      });
    } catch { finish(); }
  });
}

/**
 * Which release a machine being put back together should install.
 *
 * "Latest" is not a version. A machine rebuilt a month after it was lost would
 * install whatever is newest that day and then restore a profile written by a
 * SillyTavern from before it - an upgrade nobody asked for, performed on the
 * reader's only copy of their data, by a machine that was meant to be putting
 * things back the way they were. So the release the bucket remembers wins, and
 * the reader upgrades when they choose to.
 *
 * Anything the runtime would not accept - a record from a version that wrote
 * something else there, a ref with a path traversal in it - falls back to
 * latest rather than leaving the machine with nothing installed at all.
 */
export function releaseToInstall(remembered: string | null | undefined): VersionSelector {
  return remembered && isVersionSelector(remembered) ? remembered : 'latest';
}

function isVersionSelector(value: string): boolean {
  return value === 'latest' || value === 'release' || value === 'staging' || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value);
}

function isLogSourceFilter(value: string): value is LogSourceFilter {
  return value === 'all' || value === 'manager' || value === 'sillytavern' || value === 'cloudflared' || value === 'installer' || value === 'backup';
}

async function handlePasswordSetup(
  context: RequestContext,
  store: StateStore,
  sessions: SessionStore,
  rateLimiter: RateLimiter,
  secureCookies: boolean,
  /** Run once the password is saved, after the answer is on its way back. */
  afterSetup?: () => Promise<void>,
): Promise<void> {
  if (!checkRateLimit(context, rateLimiter)) {
    return;
  }
  const state = await store.getPersisted();
  if (state.adminPasswordHash) {
    sendError(context.response, 409, 'already_configured', 'The manager admin password is already configured');
    return;
  }
  const body = await readJson(context.request);
  if (!isRecord(body)) {
    sendError(context.response, 400, 'invalid_input', 'A JSON object is required');
    return;
  }
  const password = body.password;
  const passwordError = validatePassword(password);
  if (passwordError) {
    sendError(context.response, 400, 'invalid_password', passwordError);
    return;
  }
  if (typeof password !== 'string') {
    sendError(context.response, 400, 'invalid_password', 'Password is required');
    return;
  }
  if (body.termsAccepted !== true || body.telemetryAccepted !== true) {
    sendError(context.response, 400, 'notice_acceptance_required', 'Terms and the telemetry notice must be accepted');
    return;
  }
  const saved = await store.saveAdminPassword(hashPassword(password));
  if (!saved) {
    sendError(context.response, 409, 'already_configured', 'The manager admin password is already configured');
    return;
  }
  clearRateLimit(context, rateLimiter);
  const created = sessions.create();
  context.response.setHeader('Set-Cookie', sessionCookie(created.token, secureCookies));
  const session = created.session;
  sendJson(context.response, 201, { ok: true, setupRequired: false, session, token: created.token });
  // After the answer, not before it: what follows takes minutes, and the
  // reader is waiting to be let into the console.
  if (afterSetup) await afterSetup().catch(() => undefined);
}

async function handleLogin(
  context: RequestContext,
  store: StateStore,
  sessions: SessionStore,
  rateLimiter: RateLimiter,
  secureCookies: boolean,
): Promise<void> {
  if (!checkRateLimit(context, rateLimiter)) {
    return;
  }
  const state = await store.getPersisted();
  if (!state.adminPasswordHash) {
    sendError(context.response, 409, 'setup_required', 'Create the manager admin password first');
    return;
  }
  const body = await readJson(context.request);
  const password = isRecord(body) && typeof body.password === 'string' ? body.password : '';
  if (!verifyPassword(password, state.adminPasswordHash)) {
    sendError(context.response, 401, 'invalid_credentials', 'The password is incorrect');
    return;
  }
  clearRateLimit(context, rateLimiter);
  const created = sessions.create();
  context.response.setHeader('Set-Cookie', sessionCookie(created.token, secureCookies));
  // Also in the body, for a panel whose cookie the browser will not keep.
  sendJson(context.response, 200, { ok: true, session: created.session, token: created.token });
}

function requireSession(context: RequestContext, sessions: SessionStore): { csrfToken: string } | null {
  const session = sessions.get(context.sessionToken);
  if (!session) {
    sendError(context.response, 401, 'unauthorized', 'Manager admin authentication is required');
    return null;
  }
  return session;
}

function requireCsrf(context: RequestContext, csrfToken: string): boolean {
  const supplied = headerValue(context.request.headers['x-csrf-token']);
  if (!supplied || !constantTimeStringEqual(supplied, csrfToken)) {
    sendError(context.response, 403, 'csrf_failed', 'A valid CSRF token is required');
    return false;
  }
  return true;
}

function checkRateLimit(context: RequestContext, rateLimiter: RateLimiter): boolean {
  const result = rateLimiter.check(rateLimitKey(context));
  if (!result.allowed) {
    context.response.setHeader('Retry-After', result.retryAfterSeconds.toString(10));
    sendError(context.response, 429, 'rate_limited', 'Too many attempts; try again later');
    return false;
  }
  return true;
}

/**
 * Forget what this visitor spent, because they have just proved who they are.
 *
 * The limiter is there to make guessing expensive, and a sign-in that worked is
 * not a guess. Without this the budget is spent by ordinary use: every visit
 * costs an attempt whether or not it was the right password, so a console
 * opened and closed ten times in an afternoon locks its own owner out for a
 * quarter of an hour. Failures still count, and still count strictly.
 */
function clearRateLimit(context: RequestContext, rateLimiter: RateLimiter): void {
  rateLimiter.clear(rateLimitKey(context));
}

/**
 * Which visitor an attempt is counted against.
 *
 * The socket's address, except that through the tunnel there is only one. A
 * request that arrives from the internet goes Worker, tunnel, `cloudflared`,
 * and reaches this process over the loopback like every other - so everybody
 * outside shares a single address with the browser on the machine itself, and
 * ten bad passwords from anywhere lock out the person sitting in front of it.
 *
 * So where something in front of this manager says who is behind it, that is
 * the visitor. `CF-Connecting-IP` is the answer Cloudflare writes itself and
 * overwrites whatever a client sent, which is why it is preferred;
 * `X-Forwarded-For` is a chain each hop appends to, so the last entry is the
 * one added nearest here and the earlier ones may be anything the client typed.
 */
function rateLimitKey(context: RequestContext): string {
  return forwardedClientAddress(context.request) ?? context.request.socket.remoteAddress ?? 'unknown';
}

/**
 * The visitor's address according to a proxy, when there is one to believe.
 *
 * Believed only on the tunnel path: the request reached this process over the
 * loopback - which is where `cloudflared` connects from - while being addressed
 * to somewhere that is not this machine. A browser on the machine itself asks
 * for `localhost` and fails that test, and a browser on the LAN connects from
 * its own address rather than the loopback, so neither can put a header on a
 * request and be counted as somebody else. Anything already on this machine can
 * do far more than skew a counter, so it is not what this is guarding against.
 */
function forwardedClientAddress(request: IncomingMessage): string | null {
  if (!isLoopbackHost(request.socket.remoteAddress ?? '')) return null;
  if (!requestAddressedElsewhere(request)) return null;
  const connecting = headerValue(request.headers['cf-connecting-ip'])?.trim();
  if (connecting) return connecting;
  const chain = headerValue(request.headers['x-forwarded-for']);
  const nearest = chain?.split(',').at(-1)?.trim();
  return nearest ? nearest : null;
}

/** Whether the request was made to an address that is not this machine. */
function requestAddressedElsewhere(request: IncomingMessage): boolean {
  const addressed = forwardedValue(request, 'x-forwarded-host') ?? headerValue(request.headers.host);
  if (!addressed) return false;
  try {
    return !isLoopbackHost(new URL(`http://${addressed}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Where the browser that made this request actually is.
 *
 * This is the address a Cloudflare sign-in has to come back to, and getting it
 * wrong is not a cosmetic fault: the session lives in a cookie for one origin,
 * so a sign-in started on `http://localhost:7860` and returned to the tunnel's
 * address arrives with no session at all and is refused with `login_required`
 * - having spent the authorization code on the way.
 *
 * That is exactly what used to happen. The console preferred the first public
 * origin it knew over what the browser said, so opening the tunnel broke the
 * sign-in for everybody still using the console on the machine itself.
 *
 * The browser's own `Origin` is therefore the answer whenever the console
 * would accept a request from it - which covers this machine, the LAN address,
 * the tunnel and the Worker in front of it.
 *
 * With one exception, which is what the old rule was reaching for. A port
 * forwarder such as a Codespace rewrites the request on its way through, and
 * what arrives says loopback for both `Host` and `Origin` although the browser
 * is nowhere near this machine. So a loopback origin is believed only when no
 * proxy publishes this manager: where one does, the loopback address is not
 * anywhere a browser can come back to, and the published address is.
 */
function panelOrigin(context: RequestContext): string | null {
  const stated = headerValue(context.request.headers.origin);
  if (stated && stated !== 'null' && context.originTrusted) {
    try {
      const origin = new URL(stated);
      if (!context.proxiedOrigin || !isLoopbackHost(origin.hostname)) return origin.origin;
    } catch { /* fall through to what is known */ }
  }
  /*
   * Nothing usable in `Origin`, so the request's own address is the next best
   * thing - and it is a better answer than a published address, which belongs
   * to whoever opened that link rather than to whoever is asking. Without
   * this, a sign-in started on the machine itself was sent back to the
   * console's Worker: the page that started it sat on the sign-in screen while
   * an address nobody was looking at became the one that was signed in.
   *
   * A proxy that rewrites the request still comes first, which is the case the
   * rule above is written for: there the loopback address in `Host` is not
   * anywhere a browser can come back to, and the configured one is.
   */
  const stayHere = forwardedValue(context.request, 'x-forwarded-host') ?? headerValue(context.request.headers.host);
  const scheme = requestIsSecure(context.request) ? 'https' : 'http';
  const fallback = context.proxiedOrigin
    ?? (stayHere ? `${scheme}://${stayHere}` : null)
    ?? context.publicOrigins[0]
    ?? 'http://localhost';
  try { return new URL(fallback).origin; } catch { return null; }
}

/** Whether a hostname is this machine talking to itself. */
/** The address a browser used to reach this manager, straight from the request. */
function requestOrigin(context: RequestContext): string | null {
  const host = forwardedValue(context.request, 'x-forwarded-host') ?? headerValue(context.request.headers.host);
  if (!host) return null;
  const scheme = requestIsSecure(context.request) ? 'https' : 'http';
  try { return new URL(`${scheme}://${host}`).origin; } catch { return null; }
}

/**
 * That address, when it is one worth keeping open.
 *
 * A loopback address is not learned: it is what the keeper falls back to
 * anyway, and remembering it would pin the manager to it on the day it moves
 * somewhere that does have an address of its own.
 *
 * Neither is the Worker or the tunnel. Both are addresses a reader genuinely
 * arrives at, so they turn up here honestly - and reaching either leaves the
 * machine, crosses Cloudflare and comes back, spending an allowance that
 * exists for readers on a request no reader made.
 */
function keepableOrigin(origin: string | null, excluded: ReadonlyArray<string | null | undefined>): string | null {
  if (!origin) return null;
  let host: string;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return null; }
  if (isLoopbackHost(host)) return null;
  for (const address of excluded) {
    if (!address) continue;
    try { if (new URL(address).hostname.toLowerCase() === host) return null; } catch { /* not an address, so not this one */ }
  }
  return origin;
}

function isLoopbackHost(hostname: string): boolean {
  // An IPv4 address reaching an IPv6 socket arrives written `::ffff:127.0.0.1`,
  // which is the ordinary shape of a loopback connection on a dual-stack
  // machine and has to read as one.
  const host = hostname.replace(/^\[|\]$/gu, '').replace(/^::ffff:/iu, '');
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./u.test(host);
}

function isTrustedOrigin(request: IncomingMessage, publicOrigins: readonly string[]): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) {
    return true;
  }
  if (origin === 'null') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    const host = headerValue(request.headers.host);
    if (host && parsed.host === host) return true;
    // A port-forwarding proxy rewrites `Host` to the loopback address it
    // connects to, so the panel's own origin no longer matches it.
    if (publicOrigins.includes(parsed.origin)) return true;
    // A proxy that rewrites `Host` is meant to leave the address the browser
    // actually used here. Believing it costs nothing a browser can spend: a
    // page on another site cannot put this header on a request without asking
    // permission first, in a preflight this console never grants.
    const forwardedHost = forwardedValue(request, 'x-forwarded-host');
    if (forwardedHost && parsed.host === forwardedHost) return true;
    /*
     * Anything else is another site asking, and is refused.
     *
     * There is deliberately no list of hosting domains here. A provider's
     * domain admits every tenant on it, so trusting one by name trusts
     * everybody who rents a subdomain of it - and this project has no
     * relationship with any provider that would let it tell them apart. A
     * console reached through a platform names the address it is reached at
     * in `STM_PUBLIC_ORIGIN`, which is somebody deciding on purpose rather
     * than this file deciding for them.
     */
    return false;
  } catch {
    return false;
  }
}

/**
 * The session this request is making, from wherever the browser could put it.
 *
 * The cookie is the ordinary answer and stays the fallback. It is not the only
 * one because the console is sometimes a document inside another site's page,
 * where its cookie is a third-party cookie and the browser may decline to
 * store it at all - the password is accepted, and every call after it is
 * refused for want of a session that was never kept.
 *
 * So the panel is also handed the token outright at sign-in and sends it back
 * as `Authorization: Bearer`, which nothing blocks. A header is read first
 * because a panel that sets one is naming the session it means, and a cookie
 * left over from some other session in the same browser must not win over it.
 *
 * Deliberately not read from the query string. A token in an address is a
 * token in the browser's history, in a `Referer` sent to another site, and in
 * whatever writes the access log.
 */
/**
 * Name this sign-in for collection, where the console says it needs one.
 *
 * Asked for by the page rather than decided here, because it is the page that
 * knows: a console that can send itself to Cloudflare reads the answer in its
 * own address when it comes back, and has nothing to collect.
 */
function openHandoff(context: RequestContext, handoffs: HandoffStore, url: string): { handoff?: string } {
  // A plain option on the request, not a secret, so the query string is the
  // right place for it. What comes back is the secret, and that is in the body.
  if (context.searchParams.get('handoff') !== '1') return {};
  const state = new URL(url).searchParams.get('state');
  return state ? { handoff: handoffs.open(state) } : {};
}

function parseSessionToken(request: IncomingMessage): string | undefined {
  const authorization = headerValue(request.headers.authorization);
  if (authorization && /^Bearer /i.test(authorization)) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  return parseSessionCookie(headerValue(request.headers.cookie), COOKIE_NAME);
}

/**
 * Whether the browser reached the console over HTTPS.
 *
 * Not the same question as whether this process is speaking TLS. A console on
 * a hosting platform is behind a proxy that terminates HTTPS and forwards plain
 * HTTP over the loopback, so the connection here is the insecure half of a
 * secure request, and the header the proxy adds is the only record of the other
 * half. It decides whether the session cookie may say `Secure`, and with it
 * whether the cookie survives being read inside a frame.
 */
function requestIsSecure(request: IncomingMessage): boolean {
  const forwarded = forwardedValue(request, 'x-forwarded-proto');
  if (forwarded) return forwarded === 'https';
  return 'encrypted' in request.socket;
}

/**
 * The first entry of a forwarded header.
 *
 * Each proxy a request passes through appends its own, so a chain arrives as
 * `https, http` - and the first is the one the browser used, which is the only
 * one any of this cares about.
 */
function forwardedValue(request: IncomingMessage, header: 'x-forwarded-host' | 'x-forwarded-proto'): string | null {
  const raw = headerValue(request.headers[header]);
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim().toLowerCase();
  return first ? first : null;
}

/**
 * The address the panel is reached at from outside, when the request cannot say.
 *
 * A manager behind a port-forwarding proxy sees `Host` rewritten to the loopback
 * address the proxy connects to; GitHub Codespaces rewrites `Origin` to match,
 * which leaves nothing in the request that names the address the browser used.
 * The Cloudflare sign-in would then be sent back to a loopback address that is
 * not the reader's machine. `STM_PUBLIC_ORIGIN` settles it for any proxy, and a
 * Codespace already names itself in the environment.
 */
export function publicOriginFromEnvironment(env: NodeJS.ProcessEnv, port: number): EnvironmentOrigin | null {
  const configured = env.STM_PUBLIC_ORIGIN?.trim();
  if (configured) {
    let parsed: URL;
    try { parsed = new URL(configured); } catch { throw new Error(`STM_PUBLIC_ORIGIN is not a valid URL: ${configured}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`STM_PUBLIC_ORIGIN must be an http or https address: ${configured}`);
    }
    return { origin: parsed.origin, source: 'configured' };
  }
  const codespace = env.CODESPACE_NAME?.trim();
  const forwardingDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (codespace && forwardingDomain) {
    return { origin: `https://${codespace}-${port.toString(10)}.${forwardingDomain}`, source: 'platform' };
  }
  return null;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BYTES) {
      throw new RequestError(413, 'payload_too_large', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) {
    return;
  }
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

/**
 * Answer a list request, paged only if it asked to be.
 *
 * A caller that sends no paging parameters gets the whole list and a `page`
 * block describing it as one page - which is what every caller in the panel
 * did before this existed, and what the overview still does when it wants the
 * most recent backup out of the list. Quietly starting to answer those with
 * the first ten rows would hide data nobody asked to hide.
 */
function sendList<Row>(
  response: ServerResponse,
  key: string,
  rows: readonly Row[],
  searchParams: URLSearchParams,
  options: { searchText: (row: Row) => string; sortValue: (row: Row, column: string) => string | number | boolean | null | undefined },
  extra: Record<string, unknown> = {},
): void {
  const query = parseTableQuery(searchParams);
  if (!query) {
    sendJson(response, 200, {
      [key]: rows,
      // Unpaged, the page holds everything - but never a size of zero, which
      // is a division waiting to happen in whatever reads this next.
      page: { page: 1, pageSize: Math.max(rows.length, 1), total: rows.length, pageCount: 1 },
      ...extra,
    });
    return;
  }
  const result = applyQuery(rows, query, options);
  sendJson(response, 200, { [key]: result.rows, page: pageInfo(result, query.pageSize), ...extra });
}

function sendError(response: ServerResponse, statusCode: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  sendJson(response, statusCode, body);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}


interface SettlePortOptions {
  readonly resolved: ResolvedPort;
  readonly host: string;
  readonly reserved: readonly number[];
  readonly onMove: (from: number, to: number) => void;
  readonly onDemandedTaken: (port: number) => void;
}

/**
 * The port to actually use, once the machine has had a say.
 *
 * A port somebody wrote down, or that the host published, is used whether or
 * not it is free: it is the only address that works, so binding it and failing
 * says what is wrong, while quietly listening elsewhere would not. A port that
 * is only this project's own preference moves out of the way instead, because
 * nothing outside this process knows that number yet.
 */
async function settlePort(options: SettlePortOptions): Promise<number> {
  const { port, source } = options.resolved;
  if (await isPortFree(port, options.host)) return port;
  if (portWasDemanded(source)) {
    options.onDemandedTaken(port);
    return port;
  }
  const moved = await findFreePort(port + 1, { reserved: options.reserved, host: options.host });
  // Nothing free in range is a machine no retry here can improve, so the
  // preferred port goes ahead and reports its own failure in the usual place.
  if (moved === null) return port;
  options.onMove(port, moved);
  return moved;
}

/**
 * Put a profile that has nothing in it back from the bucket, if it can be.
 *
 * Called wherever a default profile has just been settled and before
 * SillyTavern is started on it. On a machine that keeps its disk this does
 * nothing after the first install, because the profile is never empty again.
 * On a machine that does not, it is the difference between coming back to
 * yesterday's chats and coming back to a new installation.
 *
 * Restored straight into the profile rather than through the path the panel
 * uses, which stops SillyTavern and takes a safety copy first: SillyTavern is
 * not running yet at either call site, and a safety copy of an empty profile is
 * a slow way to archive nothing.
 */
/**
 * Say that the bucket holds data this machine has not got, before it is asked.
 *
 * Costs one listing, and only on a start with nothing installed, which is the
 * one start where it answers a question somebody is about to have.
 */
async function announceRecoverable(r2: R2Manager, logger: LogSink): Promise<void> {
  try {
    const config = await r2.getConfig();
    if (!config.enabled || !config.configured) return;
    const snapshots = await r2.listSnapshots();
    const newest = snapshots[0];
    if (!newest) return;
    logger(logEvent('r2.awaitingInstall', `[r2] the bucket holds ${snapshots.length} recovery point(s), the newest from ${newest.createdAt}; installing SillyTavern brings the newest one back automatically`, { count: snapshots.length, createdAt: newest.createdAt }));
  } catch {
    // A bucket that cannot be reached on the way up is not worth a line here:
    // the console is about to be open, and it says so there.
  }
}

async function recoverEmptyProfile(settle: () => Promise<Profile>, r2: R2Manager, backups: BackupStore, jobs: JobStore, metricsFile: string, running?: { readonly job: Job; readonly signal: AbortSignal }): Promise<void> {
  /*
   * The backup slot is held from before the profile exists.
   *
   * Bringing a profile back takes a minute or two of downloading, and the
   * scheduler ticks every minute. Without this it woke up in the middle of one,
   * found a profile holding the four files that had arrived so far, and wrote
   * that to the bucket as a recovery point - which is then the newest one
   * there, and the one the next wiped machine would be given back. A backup of
   * a profile caught mid-restore is worse than no backup: it is the shape of
   * the reader's data with nothing in it.
   *
   * Reserved rather than queued: the restore inside this takes the slot itself,
   * and waiting for a slot this already holds would wait forever.
   */
  const release = backups.reserve();
  try {
    const profile = await settle();
    const config = await r2.getConfig();
    // Nowhere to recover from. On a machine that is wiped between runs this is
    // the case where the R2 settings went with everything else, which is why the
    // ones that survive - from the environment - are the ones that matter here.
    if (!config.enabled || !config.configured) return;
    /*
     * Nothing here to put anything into, so the bucket is not even asked.
     *
     * Asked before the job below rather than only inside the recovery, because
     * this runs on every start of every manager and the overwhelming majority
     * of them have a profile with data in it. A bar that appears and finishes
     * having done nothing, once per start, teaches the reader to ignore the
     * one time it means something.
     */
    if (!await isProfileEmpty(profile)) return;
    /*
     * A job, because this is minutes of downloading nobody asked for.
     *
     * It used to run with no job at all: one line in the log saying a recovery
     * point was being brought back, and then silence for as long as several
     * thousand files take to arrive. On a console that had just been opened
     * with a Cloudflare account - where this is the whole point of having
     * signed in - the reader was left looking at an empty Overview with
     * nothing moving on it, which is indistinguishable from a manager that
     * did nothing. The job carries the same bar, the same rate and the same
     * Stop button as a download somebody pressed for themselves.
     *
     * Made here rather than around the whole of this function, because until
     * the profile has settled and the bucket has answered there may be nothing
     * to bring back - and a bar that appears and vanishes having done nothing
     * is worse than no bar.
     */
    // The caller may already be holding one - a sign-in opens it before any of
    // this, so the console has something to show from the first answer it gets
    // rather than an Install button somebody is about to press by mistake.
    const { job, signal } = running ?? jobs.createOperation('r2Fetch', logEvent('job.checkingAccount', 'Checking this account for data to bring back'));
    const meter = new TransferMeter();
    const restored = await recoverProfileFromR2({
      profile, r2, backups, signal,
      logger: (line) => jobs.append('backup', line),
      onProgress: (progress) => {
        const { percent, params } = meter.update(progress);
        jobs.updateOperation(job.id, percent, logEvent('job.fetchingChunks', `Fetching ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
      },
      // Nobody is here to be asked, and the profile this writes into is empty,
      // so there is nothing an odd-looking recovery point could destroy.
      restore: async (archivePath) => { await backups.restore(profile, archivePath, { mode: 'replace', force: true }); },
      metricsFile,
    }).then(
      // A job handed in from outside is finished by whoever opened it, which
      // is what keeps a sign-in one job from beginning to end.
      (result) => { if (!running) jobs.finishOperation(job.id, 'succeeded', null); return result; },
      (error: unknown) => { if (!running) jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'The recovery point could not be brought back'); throw error; },
    );
    // Nobody was watching while this ran. The card says it happened, and says it
    // of the recovery point rather than of the archive that carried it here:
    // when the data was taken is what the reader is trying to work out.
    if (restored) await r2.recordRecovery({ createdAt: restored.point.createdAt, fileCount: restored.manifest.fileCount, sizeBytes: restored.manifest.sizeBytes });
  } finally {
    release();
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function servePanel(request: IncomingMessage, response: ServerResponse, pathname: string, staticRoot: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendError(response, 405, 'method_not_allowed', 'Only GET is supported for the manager panel');
    return;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendError(response, 400, 'invalid_path', 'The requested path is invalid');
    return;
  }
  const candidate = resolve(staticRoot, `.${decodedPath === '/' ? '/index.html' : decodedPath}`);
  const relativeCandidate = relative(staticRoot, candidate);
  if (relativeCandidate.startsWith('..') || relativeCandidate.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    sendError(response, 404, 'not_found', 'Route not found');
    return;
  }

  let filePath = candidate;
  try {
    const details = await stat(filePath);
    if (!details.isFile()) {
      throw new Error('Not a file');
    }
  } catch {
    filePath = join(staticRoot, 'index.html');
    try {
      const details = await stat(filePath);
      if (!details.isFile()) {
        throw new Error('Panel entry is not a file');
      }
    } catch {
      sendError(response, 404, 'panel_unavailable', 'The manager panel has not been built yet');
      return;
    }
  }

  const body = await readFile(filePath);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentTypeFor(filePath));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', cacheControlFor(filePath));
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(body);
}

/**
 * How long the browser may keep a static file.
 *
 * Only the bundler's output carries a content hash in its name, so only it can
 * be kept forever. The brand icons and the manifest keep their names across
 * every release, and a year-long `immutable` on those meant a changed icon was
 * never picked up again on a machine that had loaded the old one once.
 */
function cacheControlFor(filePath: string): string {
  if (filePath.endsWith('index.html')) return 'no-cache';
  const inBundle = filePath.includes(`${sep}assets${sep}`);
  return inBundle ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extension] ?? 'application/octet-stream';
}

class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly controllers = new Map<string, AbortController>();

  public constructor(private readonly logBuffer = new LogBuffer()) {}

  public append(source: LogEntry['source'], line: LogLine, level: LogEntry['level'] = 'info'): void {
    this.logBuffer.append(source, line, level);
  }

  public logs(after: number, source: LogEntry['source'] | null): { entries: LogEntry[]; nextCursor: number } {
    return this.logBuffer.read(after, source);
  }

  public logHistory(before: number, source: LogEntry['source'] | null, limit: number): { entries: LogEntry[]; hasMore: boolean } {
    return this.logBuffer.readBefore(before, source, limit);
  }

  /**
   * An installation job, and the controller that stops it.
   *
   * A first install is a Git fetch, an `npm install` and a start of
   * SillyTavern - minutes, and a good deal more than that on a phone. It used
   * to be the one long job in this manager with no way out of it: a restore or
   * an upload could be stopped, and the thing somebody is most likely to have
   * started by mistake could not.
   */
  public create(installationId: string, controller?: AbortController): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job-${installationId}`,
      kind: 'installation',
      state: 'running',
      progress: 0,
      step: 'Starting installation',
      stepCode: 'install.starting',
      installationId,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.jobs.set(job.id, job);
    if (controller) this.controllers.set(job.id, controller);
    return job;
  }

  /**
   * Start an operation the operator can stop.
   *
   * A restore or a large upload runs for minutes in the server, and until now
   * the only way out of one started by mistake was to kill the manager. The
   * returned signal is what the work watches.
   */
  public createOperation(kind: Exclude<JobKind, 'installation'>, step: LogEvent): { job: Job; signal: AbortSignal } {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job-${randomUUID()}`,
      kind,
      state: 'running',
      progress: 0,
      step: step.message,
      stepCode: step.code,
      ...(step.params ? { stepParams: step.params } : {}),
      installationId: null,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.jobs.set(job.id, job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    return { job, signal: controller.signal };
  }

  /** Ask a running operation to stop. False when there is nothing to stop. */
  public cancel(id: string): boolean {
    const current = this.jobs.get(id);
    const controller = this.controllers.get(id);
    if (!current || !controller || current.state !== 'running') return false;
    controller.abort();
    this.jobs.set(id, { ...current, step: 'Stopping', stepCode: 'job.stopping', updatedAt: new Date().toISOString() });
    return true;
  }

  public wasCanceled(id: string): boolean { return this.controllers.get(id)?.signal.aborted === true; }

  public get(id: string): Job | null { return this.jobs.get(id) ?? null; }

  /**
   * The backup or restore a reloading panel should reattach to.
   *
   * A restore runs for minutes in the server, not the browser, so a reload
   * must not look like nothing is happening - the operator would start it
   * again on top of the one already running.
   */
  /**
   * The installation that is running, for a panel that did not start it.
   *
   * A reloaded page, or one that came back to a manager which installed
   * SillyTavern by itself on first run: both need the job to follow, and to
   * stop it if they want to.
   */
  public activeInstallation(): Job | null {
    for (const job of this.jobs.values()) if (job.state === 'running' && job.kind === 'installation') return job;
    return null;
  }

  public activeOperation(): Job | null {
    let newest: Job | null = null;
    for (const job of this.jobs.values()) {
      if (job.state !== 'running' || !OPERATION_JOB_KINDS.includes(job.kind)) continue;
      if (!newest || job.createdAt > newest.createdAt) newest = job;
    }
    return newest;
  }

  public updateFromProgress(installationId: string, progress: InstallationProgress): void {
    const id = `job-${installationId}`;
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, progress: progress.progress, step: progress.step.message, stepCode: progress.step.code, ...(progress.step.params ? { stepParams: progress.step.params } : {}), updatedAt: new Date().toISOString() });
  }

  public finish(installationId: string, state: 'succeeded' | 'failed', error: string | null): void {
    const id = `job-${installationId}`;
    const current = this.jobs.get(id);
    if (!current) return;
    // Asked for, so it is not a failure and carries no error to explain.
    const settled: JobState = state === 'failed' && this.wasCanceled(id) ? 'canceled' : state;
    this.controllers.delete(id);
    this.jobs.set(id, {
      ...current,
      state: settled,
      progress: settled === 'succeeded' ? 100 : current.progress,
      step: settled === 'succeeded' ? 'Installation ready' : settled === 'canceled' ? 'Installation stopped' : 'Installation failed',
      stepCode: settled === 'succeeded' ? 'install.ready' : settled === 'canceled' ? 'install.canceled' : 'install.failed',
      error: settled === 'canceled' ? null : error,
      updatedAt: new Date().toISOString(),
    });
  }

  public updateOperation(id: string, progress: number, step: LogEvent): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, progress: Math.max(0, Math.min(100, Math.round(progress))), step: step.message, stepCode: step.code, ...(step.params ? { stepParams: step.params } : {}), updatedAt: new Date().toISOString() });
  }

  /**
   * `evenIfCanceled` keeps a failure that happened after a stop reported as one.
   * `backupId` names an archive the job produced, for a panel that has to act on it.
   */
  public finishOperation(id: string, state: 'succeeded' | 'failed', error: string | null, options: { readonly evenIfCanceled?: boolean; readonly stepCode?: string | undefined; readonly backupId?: string | undefined } = {}): void {
    const current = this.jobs.get(id);
    if (!current) return;
    const settled: JobState = state === 'failed' && this.wasCanceled(id) && !options.evenIfCanceled ? 'canceled' : state;
    const step = settled === 'succeeded' ? 'Completed' : settled === 'canceled' ? 'Stopped' : 'Failed';
    const stepCode = options.stepCode ?? (settled === 'succeeded' ? 'job.completed' : settled === 'canceled' ? 'job.stopped' : 'job.failed');
    this.controllers.delete(id);
    this.jobs.set(id, { ...current, state: settled, progress: settled === 'succeeded' ? 100 : current.progress, step, stepCode, ...(options.backupId ? { resultBackupId: options.backupId } : {}), error: settled === 'canceled' ? null : error, updatedAt: new Date().toISOString() });
  }
}

class RequestError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const managerPorts: ManagerPorts = {
  access: ACCESS_GATEWAY_PORT,
  manager: MANAGER_PORT,
  sillyTavern: SILLYTAVERN_PORT,
};

export const minimumAdminPasswordLength = MIN_PASSWORD_LENGTH;
