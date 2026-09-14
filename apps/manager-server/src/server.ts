import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { extname, join, relative, resolve } from 'node:path';
import { logEvent, logLineText, type ApiErrorBody, type ConfigUpdateInput, type HealthResponse, type Installation, type Job, type JobState, type LogEntry, type LogEvent, type LogLine, type LogSink, type LogSourceFilter, type ManagerPorts, type ProfileLayout, type SetupStatus, type VersionSelector } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, type PlatformPaths } from '../../../packages/platform/src/index.js';
import { RuntimeError, RuntimeManager, type InstallationProgress } from '../../../packages/sillytavern-runtime/src/index.js';
import { hashPassword, MIN_PASSWORD_LENGTH, validatePassword, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { parseSessionCookie, SessionStore, clearSessionCookie, sessionCookie } from './sessions.js';
import { hashSetupCode, StateStore } from './state.js';
import { LOG_LIMITS, LogBuffer } from './log-buffer.js';
import { SystemStore } from './system.js';
import { panelStaticRoot } from './bootstrap.js';
import { ProcessSupervisor } from './supervisor.js';
import { AccessGateway, ACCESS_GATEWAY_PORT } from './gateway.js';
import { TunnelManager } from '../../../packages/tunnel/src/index.js';
import { ProfileError, ProfileStore } from '../../../packages/profiles/src/index.js';
import { BackupError, BackupStore } from '../../../packages/backup/src/index.js';
import { R2Error, R2Manager, type R2UpdateInput } from '../../../packages/r2/src/index.js';
import { BackupScheduler, syncProfileToR2 } from './r2-scheduler.js';
import { fetchSnapshotToLibrary } from './r2-restore.js';
import { TransferMeter } from './progress.js';
import { MetricsStore } from './metrics.js';
import { instrumentationLoaderPath } from '../../../packages/instrumentation/src/index.js';
import { ConfigError, ConfigStore } from '../../../packages/config/src/index.js';
import { DEFAULT_TELEMETRY_ENDPOINT, DEFAULT_TELEMETRY_ENROLLMENT_ENDPOINT, TelemetryTransport } from '../../../packages/telemetry/src/index.js';

const MANAGER_PORT = 7860 as const;
const SILLYTAVERN_PORT = 8000 as const;
const MAX_JSON_BYTES = 128 * 1024;
const TERMS_VERSION = '2026-09-09';
const TELEMETRY_NOTICE_VERSION = '2026-09-09';
const COOKIE_NAME = 'stm_session';

const NOTICE = {
  telemetry: 'This free software collects limited usage metadata to support the project. It never sends API keys, prompts, chats, model responses, or request logs.',
  terms: 'By continuing, you acknowledge the terms and the disclaimer.',
  disclaimer: 'You are responsible for your SillyTavern data, credentials, providers, backups, and compliance with applicable service terms.',
} as const;

const ACCESS_PASSWORD_MIN_LENGTH = 8;

const PROTECTED_PATHS = new Set([
  '/api/v1/versions',
  '/api/v1/installations',
  '/api/v1/profiles',
  '/api/v1/backups',
  '/api/v1/config',
  '/api/v1/access/security',
  '/api/v1/access/password',
  '/api/v1/access/network',
  '/api/v1/auth/password',
  '/api/v1/metrics',
  '/api/v1/system',
  '/api/v1/system/measure',
  '/api/v1/tunnel',
  '/api/v1/r2',
]);

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
  readonly setupCodeRequired?: boolean;
  readonly staticRoot?: string;
  readonly logger?: LogSink;
  readonly runtime?: RuntimeManager;
  readonly logBuffer?: LogBuffer;
  readonly supervisor?: ProcessSupervisor;
  readonly tunnel?: TunnelManager;
  readonly gateway?: AccessGateway;
  /** Overridable so tests can bind an ephemeral port instead of 8001. */
  readonly accessPort?: number;
  readonly profileStore?: ProfileStore;
  readonly backupStore?: BackupStore;
  readonly r2?: R2Manager;
  readonly metrics?: MetricsStore;
  readonly config?: ConfigStore;
  readonly telemetry?: TelemetryTransport;
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
  readonly gateway: AccessGateway;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly metrics: MetricsStore;
  readonly config: ConfigStore;
  readonly telemetry: TelemetryTransport;
  readonly port: number;
  close(): Promise<void>;
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly originTrusted: boolean;
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
  const runtime = options.runtime ?? new RuntimeManager({ paths, logger: (line) => { jobs.append('installer', line); baseLogger(line); } });
  const profiles = options.profileStore ?? new ProfileStore({ paths, logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  const backups = options.backupStore ?? new BackupStore({ paths, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  const r2 = options.r2 ?? new R2Manager({ paths, env, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  const metrics = options.metrics ?? new MetricsStore(paths);
  const config = options.config ?? new ConfigStore({ logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  const accessPort = options.accessPort ?? (Number(env.STM_ACCESS_PORT ?? '') || ACCESS_GATEWAY_PORT);
  const gateway = options.gateway ?? new AccessGateway({ port: accessPort, targetPort: SILLYTAVERN_PORT, logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  const supervisor = options.supervisor ?? new ProcessSupervisor({
    runtime,
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
    beforeStart: async () => {
      if (!gateway.getState().passwordConfigured) throw new Error('Set the SillyTavern password before opening a public tunnel');
      if (gateway.getState().status !== 'running') await gateway.start();
    },
    logger: (line) => { jobs.append('cloudflared', line); baseLogger(line); },
  });
  const scheduler = new BackupScheduler({ backups, profiles, r2, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
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
  const secureCookies = options.secureCookies ?? env.STM_SECURE_COOKIES === '1';
  const setupCodeRequired = options.setupCodeRequired ?? requiresSetupCode(env);
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : panelStaticRoot(env);
  let persisted = await store.load();
  const testRuntime = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || process.execArgv.includes('--test');
  const telemetryEndpoint = env.STM_TELEMETRY_ENDPOINT ?? (testRuntime ? undefined : DEFAULT_TELEMETRY_ENDPOINT);
  const telemetryEnrollmentEndpoint = env.STM_TELEMETRY_ENROLLMENT_ENDPOINT ?? (testRuntime ? undefined : DEFAULT_TELEMETRY_ENROLLMENT_ENDPOINT);
  const telemetry = options.telemetry ?? new TelemetryTransport({
    paths,
    metricsFile: metrics.filePath,
    installId: persisted.installId,
    appVersion: persisted.managerVersion,
    platform: paths.platform,
    ...(telemetryEndpoint ? { endpoint: telemetryEndpoint } : {}),
    ...(telemetryEnrollmentEndpoint ? { enrollmentEndpoint: telemetryEnrollmentEndpoint } : {}),
    ...(env.STM_TELEMETRY_ENROLLMENT_TOKEN ? { enrollmentToken: env.STM_TELEMETRY_ENROLLMENT_TOKEN } : {}),
    logger: (line) => console.log(line),
  });
  try {
    await telemetry.start();
  } catch (error: unknown) {
    console.log(`[telemetry] disabled: ${error instanceof Error ? error.message : 'initialization failed'}`);
  }

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
  if (!persisted.adminPasswordHash && persisted.setupCodeHash) {
    logger(logEvent('setup.setupCode', `[setup] one-time setup code: ${store.getSetupCodeForTests()}`, { code: store.getSetupCodeForTests() }));
  }

  const shutdownToken = env.STM_SHUTDOWN_TOKEN?.trim() || null;
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      store,
      sessions,
      rateLimiter,
      startedAt,
      secureCookies,
      setupCodeRequired,
      staticRoot,
      platform: paths.platform,
      logger,
      runtime,
      jobs,
      supervisor,
      tunnel,
      gateway,
      profiles,
      backups,
      r2,
      metrics,
      config,
      system,
      shutdownToken,
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
  const defaultHost = paths.platform === 'docker' || paths.platform === 'modelscope' ? '0.0.0.0' : '127.0.0.1';
  const host = options.host ?? env.STM_HOST ?? defaultHost;
  const port = options.port ?? MANAGER_PORT;
  await listen(server, host, port);
  const address = server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  // The door opens with the manager rather than with SillyTavern, so its
  // address is the same one every time and a saved bookmark keeps working.
  gateway.setPassword(persisted.accessPasswordHash);
  await gateway.start(persisted.accessLanEnabled);
  // The tunnel publishes the gateway, not SillyTavern, so it can come back as
  // soon as the gateway is listening - it does not have to wait for SillyTavern
  // and it does not go away again when SillyTavern is restarted.
  void tunnel.resume().catch((error: unknown) => logger(logEvent('cloudflared.resumeFailed', `[cloudflared] the tunnel could not be restored: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
  const activeInstallation = await runtime.getActiveInstallation();
  if (activeInstallation?.status === 'ready') {
    let readyInstallation = activeInstallation;
    try {
      readyInstallation = await runtime.migrateLegacyInstallation?.(activeInstallation) ?? activeInstallation;
      await profiles.ensureDefault({ installationId: readyInstallation.id, runtimePath: readyInstallation.runtimePath });
      const activeProfile = await profiles.getActive();
      // Reading it first turns a missing config into the handled error below
      // rather than a fault during startup.
      const currentConfig = activeProfile ? await config.read(activeProfile, readyInstallation) : null;
      if (activeProfile && currentConfig) await config.applyManagedDefaults(activeProfile, readyInstallation);
      await runtime.cleanupLegacyRuntimeCopies?.(readyInstallation.id);
    } catch (error: unknown) {
      logger(logEvent('installer.legacyMigrationFailed', `[installer] legacy runtime migration failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    }
    void supervisor.start().catch((error: unknown) => logger(logEvent('sillytavern.autoStartFailed', `[sillytavern] automatic startup failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
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
    gateway,
    profiles,
    backups,
    r2,
    metrics,
    config,
    telemetry,
    close: async () => { await telemetry.close(); await scheduler.close(); await tunnel.close(); await gateway.close(); await supervisor.close(); await backups.settle(); await profiles.settle(); await closeServer(server); },
  };
}

async function handleRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly store: StateStore;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly startedAt: number;
  readonly secureCookies: boolean;
  readonly setupCodeRequired: boolean;
  readonly staticRoot: string;
  readonly platform: PlatformPaths['platform'];
  readonly logger: LogSink;
  readonly runtime: RuntimeManager;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly gateway: AccessGateway;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly metrics: MetricsStore;
  readonly config: ConfigStore;
  readonly system: SystemStore;
  readonly shutdownToken: string | null;
  readonly onShutdownRequest: (() => void) | undefined;
}): Promise<void> {
  const { request, response, store, sessions, rateLimiter, startedAt, secureCookies, setupCodeRequired, staticRoot, platform, runtime, jobs, supervisor, tunnel, gateway, profiles, backups, r2, metrics, config, system, shutdownToken, onShutdownRequest } = options;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const context: RequestContext = {
    request,
    response,
    pathname,
    originTrusted: isTrustedOrigin(request, platform),
    sessionToken: parseSessionCookie(headerValue(request.headers.cookie), COOKIE_NAME),
  };

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
      manager: { version: state.managerVersion, port: MANAGER_PORT },
      setupRequired: state.adminPasswordHash === null,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      storage: { durable: store.paths.platform !== 'unknown' },
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
      setupRequired: state.adminPasswordHash === null,
      setupCodeRequired: setupCodeRequired && state.adminPasswordHash === null,
      termsVersion: TERMS_VERSION,
      telemetryNoticeVersion: TELEMETRY_NOTICE_VERSION,
      notice: NOTICE,
    };
    sendJson(response, 200, status);
    return;
  }

  if (pathname === '/api/v1/setup/password' && method === 'POST') {
    await handlePasswordSetup(context, store, sessions, rateLimiter, setupCodeRequired, secureCookies);
    return;
  }

  if (pathname === '/api/v1/auth/login' && method === 'POST') {
    await handleLogin(context, store, sessions, rateLimiter, secureCookies);
    return;
  }

  if (pathname === '/api/v1/auth/session' && method === 'GET') {
    const session = requireSession(context, sessions);
    if (!session) return;
    sendJson(response, 200, { session });
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

  const needsAuth = isProtectedPath(pathname);
  if (needsAuth) {
    const session = requireSession(context, sessions);
    if (!session) {
      return;
    }
    if (method !== 'GET' && !requireCsrf(context, session.csrfToken)) {
      return;
    }
    await handleRuntimeRequest(context, store, runtime, jobs, supervisor, tunnel, gateway, profiles, backups, r2, metrics, config, system);
    return;
  }

  sendError(response, 404, 'not_found', 'Route not found');
}

async function handleRuntimeRequest(context: RequestContext, store: StateStore, runtime: RuntimeManager, jobs: JobStore, supervisor: ProcessSupervisor, tunnel: TunnelManager, gateway: AccessGateway, profiles: ProfileStore, backups: BackupStore, r2: R2Manager, metrics: MetricsStore, config: ConfigStore, system: SystemStore): Promise<void> {
  const { pathname, request, response } = context;
  const method = request.method ?? 'GET';
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
    const changed = await store.changeAdminPassword(hashPassword(body.password));
    if (!changed) {
      sendError(response, 409, 'setup_required', 'Create the manager admin password before changing it');
      return;
    }
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
  if (pathname === '/api/v1/access/security' && method === 'GET') {
    sendJson(response, 200, gateway.getState());
    return;
  }
  if (pathname === '/api/v1/access/password' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.password !== 'string' || typeof body.confirmPassword !== 'string' || body.password !== body.confirmPassword) {
      sendError(response, 400, 'password_confirmation_mismatch', 'Enter the same SillyTavern password twice');
      return;
    }
    if (body.password.length < ACCESS_PASSWORD_MIN_LENGTH) { sendError(response, 400, 'invalid_password', `The SillyTavern password must be at least ${ACCESS_PASSWORD_MIN_LENGTH} characters`); return; }
    const passwordHash = hashPassword(body.password);
    await store.setAccessPassword(passwordHash);
    // Whoever was already inside is signed out, so a password changed because
    // it was shared too widely takes effect immediately rather than at the
    // next restart.
    gateway.setPassword(passwordHash);
    if (gateway.getState().status !== 'running') await gateway.start();
    sendJson(response, 200, gateway.getState());
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
    sendJson(response, 200, await gateway.setLan(body.lan));
    return;
  }
  if (pathname === '/api/v1/r2' && method === 'GET') {
    // This used to list the bucket to show how many objects were in it. With
    // nine thousand of them that is ten charged listings for every load of the
    // page - more charged operations than a day of backups - to display a
    // number the manager already keeps. `/api/v1/r2/objects` still lists, for
    // when somebody actually asked to see the contents.
    sendJson(response, 200, { config: await r2.getConfig() });
    return;
  }
  if (pathname === '/api/v1/r2' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body)) { sendError(response, 400, 'invalid_input', 'A JSON object is required'); return; }
    const input: R2UpdateInput = {
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.endpoint === 'string' || body.endpoint === null ? { endpoint: body.endpoint as string | null } : {}),
      ...(typeof body.bucket === 'string' || body.bucket === null ? { bucket: body.bucket as string | null } : {}),
      ...(typeof body.accountId === 'string' || body.accountId === null ? { accountId: body.accountId as string | null } : {}),
      ...(typeof body.accessKeyId === 'string' || body.accessKeyId === null ? { accessKeyId: body.accessKeyId as string | null } : {}),
      ...(typeof body.secretAccessKey === 'string' || body.secretAccessKey === null ? { secretAccessKey: body.secretAccessKey as string | null } : {}),
      ...(typeof body.localIntervalMinutes === 'number' ? { localIntervalMinutes: body.localIntervalMinutes } : {}),
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
  if (pathname === '/api/v1/r2/test' && method === 'POST') {
    sendJson(response, 200, await r2.testConnection());
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
    const profile = await profiles.getActive();
    sendJson(response, 200, { snapshots: profile ? await r2.listSnapshots(profile.id) : [] });
    return;
  }
  const snapshotMatch = /^\/api\/v1\/r2\/snapshots\/([^/]+)\/fetch$/u.exec(pathname);
  if (snapshotMatch && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before fetching a recovery point'); return; }
    const snapshotId = snapshotMatch[1] ?? '';
    // Fetching lands it in the backup library rather than writing it straight
    // into the profile. Restoring is then the path that already exists, with
    // its preview, its safety snapshot and its merge-or-replace choice.
    // It produces a backup in the library, so that is the kind of job it is.
    const { job, signal } = jobs.createOperation('backup', logEvent('job.fetchingRecoveryPoint', 'Fetching the recovery point from R2'));
    const meter = new TransferMeter();
    void fetchSnapshotToLibrary({
      profile, r2, backups, snapshotId, signal,
      logger: (line) => jobs.append('backup', line),
      onProgress: (progress) => {
        const { percent, params } = meter.update(progress);
        jobs.updateOperation(job.id, percent, logEvent('job.fetchingChunks', `Fetching ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
      },
    })
      .then(() => jobs.finishOperation(job.id, 'succeeded', null))
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
    const { job, signal } = jobs.createOperation('backup', logEvent('job.sendingToR2', 'Sending to R2'));
    const meter = new TransferMeter();
    void syncProfileToR2({
      profile, backups, r2, tier: 'cold', signal,
      logger: (line) => jobs.append('backup', line),
      onProgress: (progress) => {
        const { percent, params } = meter.update(progress);
        jobs.updateOperation(job.id, percent, logEvent('job.sendingChunks', `Sending ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
      },
    })
      .then(() => jobs.finishOperation(job.id, 'succeeded', null))
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'The R2 backup failed'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/logs' && method === 'GET') {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const afterValue = Number(url.searchParams.get('after') ?? 0);
    const sourceParam = url.searchParams.get('source') ?? 'all';
    if (!Number.isSafeInteger(afterValue) || afterValue < 0) { sendError(response, 400, 'invalid_cursor', 'The log cursor is invalid'); return; }
    if (!isLogSourceFilter(sourceParam)) { sendError(response, 400, 'invalid_source', 'The log source is invalid'); return; }
    const source = sourceParam === 'all' ? null : sourceParam;
    // `before` reads backwards through what is still retained, so a reader that
    // scrolls up can pull in older lines instead of only following new ones.
    const beforeParam = url.searchParams.get('before');
    if (beforeParam !== null) {
      const beforeValue = Number(beforeParam);
      const limitValue = Number(url.searchParams.get('limit') ?? LOG_LIMITS.historyEntries);
      if (!Number.isSafeInteger(beforeValue) || beforeValue < 0) { sendError(response, 400, 'invalid_cursor', 'The log cursor is invalid'); return; }
      if (!Number.isSafeInteger(limitValue) || limitValue < 1) { sendError(response, 400, 'invalid_limit', 'The log limit is invalid'); return; }
      sendJson(response, 200, jobs.logHistory(beforeValue, source, limitValue));
      return;
    }
    sendJson(response, 200, jobs.logs(afterValue, source));
    return;
  }
  if (pathname === '/api/v1/metrics' && method === 'GET') {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const requestedDays = Number(url.searchParams.get('days') ?? 30);
    if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 90) {
      sendError(response, 400, 'invalid_metrics_range', 'Metrics range must be between 1 and 90 days');
      return;
    }
    sendJson(response, 200, await metrics.snapshot(new Date(), requestedDays));
    return;
  }
  if (pathname === '/api/v1/versions' && method === 'GET') {
    const versions = await runtime.listVersions();
    sendJson(response, 200, { versions });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'GET') {
    const [installations, active] = await Promise.all([runtime.listInstallations(), runtime.getActiveInstallation()]);
    sendJson(response, 200, { installations, activeInstallationId: active?.id ?? null });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'POST') {
    const body = await readJson(request);
    const selector = isRecord(body) && typeof body.version === 'string' ? body.version : null;
    if (!selector || !isVersionSelector(selector)) {
      sendError(response, 400, 'invalid_version', 'A valid SillyTavern version must be selected');
      return;
    }
    const previousProfile = await profiles.getActive();
    await supervisor.stop('install');
    if (previousProfile) {
      try {
        await backups.createSafetyCopy(previousProfile, { name: `${previousProfile.name}-preswitch` });
      } catch (error: unknown) {
        await supervisor.start().catch(() => supervisor.getState());
        sendError(response, 500, 'profile_snapshot_failed', error instanceof Error ? error.message : 'Could not create a profile safety snapshot');
        return;
      }
    }
    let queuedId = '';
    let queued: { id: string; promise: Promise<Installation> };
    try {
      queued = runtime.queueInstall(selector as VersionSelector, (progress) => jobs.updateFromProgress(queuedId, progress));
    } catch (error: unknown) {
      await supervisor.start();
      if (error instanceof RuntimeError) { sendError(response, 409, error.code, error.message); return; }
      throw error;
    }
    queuedId = queued.id;
    const job = jobs.create(queued.id);
    void queued.promise.then(async (installation) => {
      jobs.finish(queued.id, installation.status === 'ready' ? 'succeeded' : 'failed', installation.error);
      if (installation.status === 'ready') {
        if (previousProfile) await profiles.rebind(previousProfile.id, installation.id, installation.runtimePath);
        else await profiles.ensureDefault({ installationId: installation.id, runtimePath: installation.runtimePath });
        await runtime.cleanupLegacyRuntimeCopies?.(installation.id);
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
    sendJson(response, 202, { installationId: queued.id, job });
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
      if (current && current.id !== profile.id) snapshot = await backups.createSafetyCopy(current, { name: `${current.name}-preswitch` });
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
    sendJson(response, 200, { backups: activeProfile ? await backups.list(activeProfile.id) : [] });
    return;
  }
  if (pathname === '/api/v1/backups' && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before creating a backup'); return; }
    const body = await readJson(request);
    const name = isRecord(body) && typeof body.name === 'string' ? body.name : undefined;
    const { job, signal } = jobs.createOperation('backup', logEvent('job.preparingBackup', 'Preparing backup'));
    void backups.create(profile, {
      ...(name ? { name } : {}),
      signal,
      onProgress: ({ completed, total }) => jobs.updateOperation(job.id, total > 0 ? (completed / total) * 90 : 50, logEvent('job.compressingFiles', `Compressing files (${completed}/${total})`, { completed, total })),
    }).then((manifest) => { jobs.updateOperation(job.id, 95, logEvent('job.savingLibrary', 'Saving backup library')); jobs.finishOperation(job.id, 'succeeded', null); return manifest; })
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'Backup failed'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/backups/import/chunk' && method === 'POST') {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const uploadId = url.searchParams.get('uploadId') ?? '';
    const index = Number(url.searchParams.get('index') ?? '');
    const chunk = await backups.appendUploadChunk(uploadId, index, request);
    sendJson(response, 200, { ok: true, ...chunk });
    return;
  }
  if (pathname === '/api/v1/backups/import/chunk' && method === 'DELETE') {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const uploadId = url.searchParams.get('uploadId') ?? '';
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
      const result = await restoreWithProcess({ profile, backups, archivePath: libraryPath, mode, supervisor });
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
      const { job, signal } = jobs.createOperation('restore', logEvent('job.preparingRestore', 'Preparing restore'));
      void restoreWithProcess({ profile, backups, archivePath, mode, supervisor, signal, onProgress: (progress, step) => jobs.updateOperation(job.id, progress, step) })
        .then(() => jobs.finishOperation(job.id, 'succeeded', null))
        .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'Restore failed'));
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
  if (pathname === '/api/v1/tunnel' && method === 'GET') { sendJson(response, 200, tunnel.getState()); return; }
  if (pathname === '/api/v1/tunnel' && method === 'PUT') {
    const body = await readJson(request);
    const mode = isRecord(body) && (body.mode === 'off' || body.mode === 'quick' || body.mode === 'named') ? body.mode : null;
    if (!mode) { sendError(response, 400, 'invalid_tunnel_mode', 'Tunnel mode must be off, quick, or named'); return; }
    if (mode !== 'off' && supervisor.getState().status !== 'running') { sendError(response, 409, 'sillytavern_not_running', 'Start SillyTavern before enabling the tunnel'); return; }
    if (mode !== 'off' && !gateway.getState().passwordConfigured) { sendError(response, 409, 'public_access_password_required', 'Set the SillyTavern password before opening a public tunnel'); return; }
    const state = mode === 'off' ? await tunnel.disable() : await tunnel.start(mode, isRecord(body) && typeof body.token === 'string' ? body.token : undefined);
    sendJson(response, 200, state);
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

/** Each apply-phase step gets its own percentage so a slow phase still shows the bar moving. */
const RESTORE_STEP_PROGRESS: Record<string, number> = {
  'restore.restoringFiles': 85,
  'restore.removingObsolete': 87,
  'restore.finalizing': 88,
};

async function restoreWithProcess(options: {
  readonly profile: Awaited<ReturnType<ProfileStore['getActive']>> & {};
  readonly backups: BackupStore;
  readonly archivePath: string;
  readonly mode: 'merge' | 'replace';
  readonly supervisor: ProcessSupervisor;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number, step: LogEvent) => void;
}): Promise<{ preview: Awaited<ReturnType<BackupStore['restore']>>; safetySnapshot: Awaited<ReturnType<BackupStore['create']>>; process: ReturnType<ProcessSupervisor['getState']> }> {
  const { profile, backups, archivePath, mode, supervisor, signal, onProgress } = options;
  // Claim the backup store before stopping anything. Otherwise the scheduler's
  // next tick sees an idle store and starts a full backup that the restore then
  // has to wait out.
  const releaseOperationSlot = backups.reserve();
  onProgress?.(5, logEvent('job.stoppingSillyTavern', 'Stopping SillyTavern'));
  await supervisor.stop('restore');
  try {
    // A safety copy has to exist before the restore overwrites anything, but it
    // does not have to be a second copy of every file. Writing one compressed
    // archive is a single large sequential write; copying the tree file by file
    // measured 639 seconds on a ModelScope volume for the same data. It only
    // An unchanged profile can reuse the backup it already has.
    onProgress?.(15, logEvent('job.creatingSafetySnapshot', 'Creating safety snapshot'));
    const safetySnapshot = await backups.createSafetyCopy(profile, {
      name: `${profile.name}-prerestore`,
      ...(signal ? { signal } : {}),
      onProgress: ({ completed, total }) => onProgress?.(15 + (total > 0 ? (completed / total) * 10 : 0), logEvent('job.backingUpCurrentData', `Backing up current data (${completed}/${total})`, { completed, total })),
    });
    onProgress?.(25, logEvent('job.restoringData', 'Restoring data'));
    const preview = await backups.restore(profile, archivePath, {
      mode,
      ...(signal ? { signal } : {}),
      onProgress: ({ completed, total }) => onProgress?.(25 + (total > 0 ? (completed / total) * 60 : 60), logEvent('job.restoringFiles', `Restoring files (${completed}/${total})`, { completed, total })),
      onStatus: (step) => onProgress?.(RESTORE_STEP_PROGRESS[step.code] ?? 86, step),
    });
    onProgress?.(90, logEvent('job.startingSillyTavern', 'Starting SillyTavern'));
    const process = await supervisor.start();
    onProgress?.(100, logEvent('job.restoreComplete', 'Restore complete'));
    return { preview, safetySnapshot, process };
  } catch (error) {
    await supervisor.start().catch(() => supervisor.getState());
    throw error;
  } finally {
    releaseOperationSlot();
  }
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
  return { settings: {
    ...(typeof settings.sslEnabled === 'boolean' ? { sslEnabled: settings.sslEnabled } : {}),
    ...(typeof settings.enableCorsProxy === 'boolean' ? { enableCorsProxy: settings.enableCorsProxy } : {}),
    ...(typeof settings.disableCsrfProtection === 'boolean' ? { disableCsrfProtection: settings.disableCsrfProtection } : {}),
  } };
}

async function decorateConfig(document: Awaited<ReturnType<ConfigStore['read']>>): Promise<Awaited<ReturnType<ConfigStore['read']>>> {
  const host = preferredNetworkHost(Object.values(networkInterfaces()).flatMap((entries) => entries ?? []), await routedAddress());
  return host ? { ...document, networkHost: host } : document;
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
  setupCodeRequired: boolean,
  secureCookies: boolean,
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
  if (setupCodeRequired) {
    if (typeof body.setupCode !== 'string' || !constantTimeStringEqual(hashSetupCode(body.setupCode), state.setupCodeHash ?? '')) {
      sendError(context.response, 403, 'invalid_setup_code', 'The setup code is invalid or expired');
      return;
    }
  }
  const saved = await store.saveAdminPassword(hashPassword(password));
  if (!saved) {
    sendError(context.response, 409, 'already_configured', 'The manager admin password is already configured');
    return;
  }
  const created = sessions.create();
  context.response.setHeader('Set-Cookie', sessionCookie(created.token, secureCookies));
  const session = created.session;
  sendJson(context.response, 201, { ok: true, setupRequired: false, session });
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
  const created = sessions.create();
  context.response.setHeader('Set-Cookie', sessionCookie(created.token, secureCookies));
  sendJson(context.response, 200, { ok: true, session: created.session });
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
  const key = context.request.socket.remoteAddress ?? 'unknown';
  const result = rateLimiter.check(key);
  if (!result.allowed) {
    context.response.setHeader('Retry-After', result.retryAfterSeconds.toString(10));
    sendError(context.response, 429, 'rate_limited', 'Too many attempts; try again later');
    return false;
  }
  return true;
}

function isTrustedOrigin(request: IncomingMessage, platform: PlatformPaths['platform']): boolean {
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
    return platform === 'modelscope' && isModelScopeOrigin(parsed.hostname);
  } catch {
    return false;
  }
}

function isModelScopeOrigin(hostname: string): boolean {
  return hostname === 'modelscope.ai'
    || hostname.endsWith('.modelscope.ai')
    || hostname === 'ms.fun'
    || hostname.endsWith('.ms.fun');
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

function requiresSetupCode(env: NodeJS.ProcessEnv): boolean {
  return env.STM_REQUIRE_SETUP_CODE === '1';
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
  response.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(body);
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
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

  public create(installationId: string): Job {
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
    return job;
  }

  /**
   * Start an operation the operator can stop.
   *
   * A restore or a large upload runs for minutes in the server, and until now
   * the only way out of one started by mistake was to kill the manager. The
   * returned signal is what the work watches.
   */
  public createOperation(kind: 'backup' | 'restore', step: LogEvent): { job: Job; signal: AbortSignal } {
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
  public activeOperation(): Job | null {
    let newest: Job | null = null;
    for (const job of this.jobs.values()) {
      if (job.state !== 'running' || (job.kind !== 'backup' && job.kind !== 'restore')) continue;
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
    this.jobs.set(id, { ...current, state, progress: state === 'succeeded' ? 100 : current.progress, step: state === 'succeeded' ? 'Installation ready' : 'Installation failed', stepCode: state === 'succeeded' ? 'install.ready' : 'install.failed', error, updatedAt: new Date().toISOString() });
  }

  public updateOperation(id: string, progress: number, step: LogEvent): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, progress: Math.max(0, Math.min(100, Math.round(progress))), step: step.message, stepCode: step.code, ...(step.params ? { stepParams: step.params } : {}), updatedAt: new Date().toISOString() });
  }

  public finishOperation(id: string, state: 'succeeded' | 'failed', error: string | null): void {
    const current = this.jobs.get(id);
    if (!current) return;
    const settled: JobState = state === 'failed' && this.wasCanceled(id) ? 'canceled' : state;
    const step = settled === 'succeeded' ? 'Completed' : settled === 'canceled' ? 'Stopped' : 'Failed';
    const stepCode = settled === 'succeeded' ? 'job.completed' : settled === 'canceled' ? 'job.stopped' : 'job.failed';
    this.controllers.delete(id);
    this.jobs.set(id, { ...current, state: settled, progress: settled === 'succeeded' ? 100 : current.progress, step, stepCode, error: settled === 'canceled' ? null : error, updatedAt: new Date().toISOString() });
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
