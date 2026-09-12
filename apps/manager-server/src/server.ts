import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import type { AccessSecurityState, ApiErrorBody, ConfigUpdateInput, HealthResponse, Installation, Job, LogEntry, LogSourceFilter, ManagerPorts, ProfileLayout, SetupStatus, VersionSelector } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, type PlatformPaths } from '../../../packages/platform/src/index.js';
import { RuntimeError, RuntimeManager, type InstallationProgress } from '../../../packages/sillytavern-runtime/src/index.js';
import { hashPassword, MIN_PASSWORD_LENGTH, validatePassword, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { parseSessionCookie, SessionStore, clearSessionCookie, sessionCookie } from './sessions.js';
import { hashSetupCode, StateStore } from './state.js';
import { LOG_LIMITS, LogBuffer } from './log-buffer.js';
import { SystemStore } from './system.js';
import { ProcessSupervisor } from './supervisor.js';
import { TunnelManager } from '../../../packages/tunnel/src/index.js';
import { ProfileError, ProfileStore } from '../../../packages/profiles/src/index.js';
import { BackupError, BackupStore } from '../../../packages/backup/src/index.js';
import { R2Error, R2Manager, type R2UpdateInput } from '../../../packages/r2/src/index.js';
import { BackupScheduler } from './r2-scheduler.js';
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

const PROTECTED_PATHS = new Set([
  '/api/v1/versions',
  '/api/v1/installations',
  '/api/v1/profiles',
  '/api/v1/backups',
  '/api/v1/config',
  '/api/v1/access/security',
  '/api/v1/access/password',
  '/api/v1/auth/password',
  '/api/v1/metrics',
  '/api/v1/system',
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
  readonly logger?: (line: string) => void;
  readonly runtime?: RuntimeManager;
  readonly logBuffer?: LogBuffer;
  readonly supervisor?: ProcessSupervisor;
  readonly tunnel?: TunnelManager;
  readonly profileStore?: ProfileStore;
  readonly backupStore?: BackupStore;
  readonly r2?: R2Manager;
  readonly metrics?: MetricsStore;
  readonly config?: ConfigStore;
  readonly telemetry?: TelemetryTransport;
}

export interface ManagerServer {
  readonly server: Server;
  readonly store: StateStore;
  readonly sessions: SessionStore;
  readonly runtime: RuntimeManager;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
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
  const baseLogger = options.logger ?? ((line: string) => console.log(line));
  const jobs = new JobStore(options.logBuffer ?? new LogBuffer(paths));
  const logger = (line: string) => { jobs.append('manager', line); baseLogger(line); };
  const runtime = options.runtime ?? new RuntimeManager({ paths, logger: (line) => { jobs.append('installer', line); baseLogger(line); } });
  const profiles = options.profileStore ?? new ProfileStore({ paths, logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  const backups = options.backupStore ?? new BackupStore({ paths, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  const r2 = options.r2 ?? new R2Manager({ paths, env, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  const metrics = options.metrics ?? new MetricsStore(paths);
  const config = options.config ?? new ConfigStore({ logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  const supervisor = options.supervisor ?? new ProcessSupervisor({
    runtime,
    profileResolver: (installation) => profiles.getActiveForInstallation(installation.id),
    profileLifecycle: {
      prepare: async (profile, runtimePath) => {
        const installation = await runtime.getInstallation(profile.installationId);
        if (installation) {
          try {
            if (await config.needsAccountMigration(profile, installation)) {
              await config.update(profile, installation, { settings: { listen: false, enableUserAccounts: true } });
            }
          } catch (error: unknown) {
            if (!(error instanceof ConfigError) || error.code !== 'config_missing') throw error;
          }
        }
        return profiles.prepareForRuntime(profile, runtimePath);
      },
      persist: (profile, runtimePath, runtimeLayout) => profiles.persistFromRuntime(profile, runtimePath, runtimeLayout),
      legacyHeapMb: (profile) => profiles.recommendedLegacyHeapMb(profile),
    },
    instrumentationPath: instrumentationLoaderPath,
    metricsFile: metrics.filePath,
    logger: (line) => { jobs.append('sillytavern', line); baseLogger(line); },
  });
  const tunnel = options.tunnel ?? new TunnelManager({ paths, env, beforeStart: async () => { await requireTunnelPassword(config, profiles, runtime, supervisor); }, logger: (line) => { jobs.append('cloudflared', line); baseLogger(line); } });
  const scheduler = new BackupScheduler({ backups, profiles, r2, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  scheduler.start();
  const system = new SystemStore({
    paths,
    childPid: () => supervisor.getState().pid,
    dataRoot: async () => {
      const profile = await profiles.getActive();
      return profile ? profile.dataPath : null;
    },
  });
  const secureCookies = options.secureCookies ?? env.STM_SECURE_COOKIES === '1';
  const setupCodeRequired = options.setupCodeRequired ?? requiresSetupCode(env);
  const staticRoot = resolve(options.staticRoot ?? env.STM_STATIC_ROOT ?? join(process.cwd(), 'apps', 'manager-panel', 'dist'));
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
    logger: (line) => { jobs.append('manager', line); baseLogger(line); },
  });
  try {
    await telemetry.start();
  } catch (error: unknown) {
    logger(`[telemetry] disabled: ${error instanceof Error ? error.message : 'initialization failed'}`);
  }

  const environmentPassword = env.STM_ADMIN_PASSWORD;
  if (environmentPassword && !persisted.adminPasswordHash) {
    const passwordError = validatePassword(environmentPassword);
    if (passwordError) {
      throw new Error(`STM_ADMIN_PASSWORD is invalid: ${passwordError}`);
    }
    await store.bootstrapAdminPassword(hashPassword(environmentPassword));
    persisted = await store.getPersisted();
    logger('[setup] admin password bootstrapped from STM_ADMIN_PASSWORD');
  }
  if (!persisted.adminPasswordHash && persisted.setupCodeHash) {
    logger(`[setup] one-time setup code: ${store.getSetupCodeForTests()}`);
  }

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
      profiles,
      backups,
      r2,
      metrics,
      config,
      system,
    }).catch((error: unknown) => {
      if (error instanceof RequestError) {
        sendError(response, error.statusCode, error.code, error.message);
        return;
      }
      if (error instanceof BackupError) {
        sendError(response, error.code === 'secrets_confirmation_required' ? 409 : 400, error.code, error.message);
        return;
      }
      if (error instanceof R2Error) {
        sendError(response, error.code === 'secrets_confirmation_required' || error.code === 'r2_not_configured' ? 409 : 400, error.code, error.message);
        return;
      }
      if (error instanceof ConfigError) {
        sendError(response, error.code === 'config_missing' ? 409 : 400, error.code, error.message);
        return;
      }
      logger(`[manager] request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
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
  const activeInstallation = await runtime.getActiveInstallation();
  if (activeInstallation?.status === 'ready') {
    let readyInstallation = activeInstallation;
    try {
      readyInstallation = await runtime.migrateLegacyInstallation?.(activeInstallation) ?? activeInstallation;
      await profiles.ensureDefault({ installationId: readyInstallation.id, runtimePath: readyInstallation.runtimePath });
      const activeProfile = await profiles.getActive();
      const currentConfig = activeProfile ? await config.read(activeProfile, readyInstallation) : null;
      const accessNeedsMigration = activeProfile ? await config.needsAccountMigration(activeProfile, readyInstallation) : false;
      if (activeProfile && currentConfig && accessNeedsMigration) {
        await config.update(activeProfile, readyInstallation, { settings: { listen: false, enableUserAccounts: true } });
        logger('[config] migrated access security to SillyTavern accounts; LAN access is waiting for an admin password');
      }
      await runtime.cleanupLegacyRuntimeCopies?.(readyInstallation.id);
    } catch (error: unknown) {
      logger(`[installer] legacy runtime migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    void supervisor.start().catch((error: unknown) => logger(`[sillytavern] automatic startup failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }

  return {
    server,
    store,
    sessions,
    runtime,
    port: actualPort,
    supervisor,
    tunnel,
    profiles,
    backups,
    r2,
    metrics,
    config,
    telemetry,
    close: async () => { await telemetry.close(); await scheduler.close(); await tunnel.close(); await supervisor.close(); await backups.settle(); await profiles.settle(); await closeServer(server); },
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
  readonly logger: (line: string) => void;
  readonly runtime: RuntimeManager;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly metrics: MetricsStore;
  readonly config: ConfigStore;
  readonly system: SystemStore;
}): Promise<void> {
  const { request, response, store, sessions, rateLimiter, startedAt, secureCookies, setupCodeRequired, staticRoot, platform, runtime, jobs, supervisor, tunnel, profiles, backups, r2, metrics, config, system } = options;
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
    await handleRuntimeRequest(context, store, runtime, jobs, supervisor, tunnel, profiles, backups, r2, metrics, config, system);
    return;
  }

  sendError(response, 404, 'not_found', 'Route not found');
}

async function handleRuntimeRequest(context: RequestContext, store: StateStore, runtime: RuntimeManager, jobs: JobStore, supervisor: ProcessSupervisor, tunnel: TunnelManager, profiles: ProfileStore, backups: BackupStore, r2: R2Manager, metrics: MetricsStore, config: ConfigStore, system: SystemStore): Promise<void> {
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
    if (method === 'GET') { sendJson(response, 200, decorateConfig(await config.read(profile, installation))); return; }
    const input = parseConfigUpdateInput(await readJson(request));
    if (await configUpdateEnablesListen(input, config)) await requireAdminAccountPassword(runtime, supervisor, profiles, config);
    const previousTunnelMode = tunnel.getState().mode;
    const wasRunning = supervisor.getState().status === 'running';
    const saved = await config.update(profile, installation, input);
    await tunnel.stop();
    const process = wasRunning ? await supervisor.restart() : supervisor.getState();
    if (previousTunnelMode !== 'off' && process.status === 'running') {
      try {
        await requireTunnelPassword(config, profiles, runtime, supervisor);
        await tunnel.restart();
      } catch {
        // Keep the tunnel stopped until the account has a password.
      }
    }
    sendJson(response, 200, { config: decorateConfig(saved), process, tunnel: tunnel.getState() });
    return;
  }
  if (pathname === '/api/v1/access/security' && method === 'GET') {
    sendJson(response, 200, await readAccessSecurityState(runtime, supervisor, profiles, config));
    return;
  }
  if (pathname === '/api/v1/access/password' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.password !== 'string' || typeof body.confirmPassword !== 'string' || body.password !== body.confirmPassword) {
      sendError(response, 400, 'password_confirmation_mismatch', 'Enter the same SillyTavern password twice');
      return;
    }
    if (body.password.length < 8) { sendError(response, 400, 'invalid_password', 'The SillyTavern password must be at least 8 characters'); return; }
    try {
      await setSillyTavernAdminPassword(supervisor, runtime, profiles, config, body.password);
      sendJson(response, 200, await readAccessSecurityState(runtime, supervisor, profiles, config));
    } catch (error: unknown) {
      if (error instanceof RequestError) { sendError(response, error.statusCode, error.code, error.message); return; }
      throw error;
    }
    return;
  }
  if (pathname === '/api/v1/r2' && method === 'GET') {
    sendJson(response, 200, { config: await r2.getConfig(), objects: await r2.listObjects().catch(() => []) });
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
      ...(typeof body.includeSecrets === 'boolean' ? { includeSecrets: body.includeSecrets } : {}),
      ...(typeof body.localIntervalMinutes === 'number' ? { localIntervalMinutes: body.localIntervalMinutes } : {}),
      ...(typeof body.r2IntervalHours === 'number' ? { r2IntervalHours: body.r2IntervalHours } : {}),
      ...(typeof body.fullIntervalDays === 'number' ? { fullIntervalDays: body.fullIntervalDays } : {}),
      ...(typeof body.maxBackups === 'number' ? { maxBackups: body.maxBackups } : {}),
      ...(typeof body.retentionDays === 'number' || body.retentionDays === null ? { retentionDays: body.retentionDays as number | null } : {}),
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
  if ((pathname === '/api/v1/r2/upload' || pathname === '/api/v1/r2/sync') && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before uploading to R2'); return; }
    const body = await readJson(request);
    const backupId = isRecord(body) && typeof body.backupId === 'string' ? body.backupId : null;
    const allowSecrets = isRecord(body) && body.includeSecrets === true;
    const manifest = backupId ? await backups.get(backupId) : await backups.create(profile, { ...(allowSecrets ? { includeSecrets: true } : {}), name: `${profile.name}-r2` });
    if (!manifest || manifest.profileId !== profile.id) { sendError(response, 404, 'backup_not_found', 'Backup not found in the active profile'); return; }
    const archivePath = await backups.getArchivePath(manifest.id);
    if (!archivePath) { sendError(response, 410, 'backup_archive_missing', 'The backup archive is missing'); return; }
    const upload = await r2.uploadArchive(archivePath, manifest, manifest.fingerprint ?? null, allowSecrets);
    sendJson(response, 200, { manifest, upload });
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
    const previousTunnelMode = tunnel.getState().mode;
    await tunnel.stop();
    await supervisor.stop();
    if (previousProfile) {
      try {
        await profiles.createSafetySnapshot(previousProfile);
      } catch (error: unknown) {
        const process = await supervisor.start().catch(() => supervisor.getState());
        if (previousTunnelMode !== 'off' && process.status === 'running') await tunnel.restart().catch(() => undefined);
        sendError(response, 500, 'profile_snapshot_failed', error instanceof Error ? error.message : 'Could not create a profile safety snapshot');
        return;
      }
    }
    let queuedId = '';
    let queued: { id: string; promise: Promise<Installation> };
    try {
      queued = runtime.queueInstall(selector as VersionSelector, (progress) => jobs.updateFromProgress(queuedId, progress));
    } catch (error: unknown) {
      const process = await supervisor.start();
      if (previousTunnelMode !== 'off' && process.status === 'running') await tunnel.restart();
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
      const process = await supervisor.start();
      if (previousTunnelMode !== 'off' && process.status === 'running') await tunnel.restart();
    }).catch(async (error: unknown) => { jobs.finish(queued.id, 'failed', error instanceof Error ? error.message : 'Installation failed'); const process = await supervisor.start(); if (previousTunnelMode !== 'off' && process.status === 'running') await tunnel.restart(); });
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
    const previousTunnelMode = tunnel.getState().mode;
    await tunnel.stop();
    await supervisor.stop();
    let snapshot = null;
    try {
      if (current && current.id !== profile.id) snapshot = await profiles.createSafetySnapshot(current);
      await runtime.activateInstallation(installation.id);
      const activated = await profiles.activate(profile.id);
      const process = await supervisor.start();
      if (previousTunnelMode !== 'off' && process.status === 'running') await tunnel.restart();
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
    const includeSecrets = isRecord(body) && body.includeSecrets === true;
    const job = jobs.createOperation('backup', 'Preparing backup');
    void backups.create(profile, {
      ...(name ? { name } : {}),
      ...(includeSecrets ? { includeSecrets: true } : {}),
      onProgress: ({ completed, total }) => jobs.updateOperation(job.id, total > 0 ? (completed / total) * 90 : 50, `Compressing files (${completed}/${total})`),
    }).then((manifest) => { jobs.updateOperation(job.id, 95, 'Saving backup library'); jobs.finishOperation(job.id, 'succeeded', null); return manifest; })
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
      const allowSecrets = headerValue(request.headers['x-include-secrets']) === 'true';
      if (mode !== 'merge' && mode !== 'replace') { sendError(response, 400, 'invalid_restore_mode', 'Restore mode must be merge or replace'); return; }
      const libraryPath = await backups.getArchivePath(imported.manifest.id);
      if (!libraryPath) { sendError(response, 500, 'backup_archive_missing', 'The uploaded archive could not be stored'); return; }
      const result = await restoreWithProcess({ profile, backups, archivePath: libraryPath, mode, allowSecrets, supervisor, tunnel });
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
      const allowSecrets = isRecord(body) && body.includeSecrets === true;
      const job = jobs.createOperation('restore', 'Preparing restore');
      void restoreWithProcess({ profile, backups, archivePath, mode, allowSecrets, supervisor, tunnel, onProgress: (progress, step) => jobs.updateOperation(job.id, progress, step) })
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
      await tunnel.stop();
      const state = action === 'stop' ? await supervisor.stop() : await supervisor.restart();
      if (action === 'restart' && state.status === 'running' && tunnel.getState().mode !== 'off') await tunnel.restart();
      sendJson(response, 200, state);
      return;
    }
  }
  if (pathname === '/api/v1/process' && method === 'GET') { sendJson(response, 200, supervisor.getState()); return; }
  if (pathname === '/api/v1/process/start' && method === 'POST') { sendJson(response, 200, await supervisor.start()); return; }
  if (pathname === '/api/v1/process/stop' && method === 'POST') { await tunnel.stop(); sendJson(response, 200, await supervisor.stop()); return; }
  if (pathname === '/api/v1/process/restart' && method === 'POST') { await tunnel.stop(); const process = await supervisor.restart(); if (tunnel.getState().mode !== 'off' && process.status === 'running') await tunnel.restart(); sendJson(response, 200, process); return; }
  if (pathname === '/api/v1/tunnel' && method === 'GET') { sendJson(response, 200, tunnel.getState()); return; }
  if (pathname === '/api/v1/tunnel' && method === 'PUT') {
    const body = await readJson(request);
    const mode = isRecord(body) && (body.mode === 'off' || body.mode === 'quick' || body.mode === 'named') ? body.mode : null;
    if (!mode) { sendError(response, 400, 'invalid_tunnel_mode', 'Tunnel mode must be off, quick, or named'); return; }
    if (mode !== 'off' && supervisor.getState().status !== 'running') { sendError(response, 409, 'sillytavern_not_running', 'Start SillyTavern before enabling the tunnel'); return; }
    if (mode !== 'off') await requireTunnelPassword(config, profiles, runtime, supervisor);
    const state = mode === 'off' ? await tunnel.stop() : await tunnel.start(mode, isRecord(body) && typeof body.token === 'string' ? body.token : undefined);
    sendJson(response, 200, state);
    return;
  }
  if (pathname === '/api/v1/system' && method === 'GET') {
    sendJson(response, 200, await system.snapshot());
    return;
  }
  if (pathname === '/api/v1/jobs/active' && method === 'GET') {
    sendJson(response, 200, { job: jobs.activeOperation() });
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
  'Applying restored data': 85,
  'Clearing existing data': 86,
  'Moving restored data into place': 87,
  'Finalizing restored data': 88,
};

async function restoreWithProcess(options: {
  readonly profile: Awaited<ReturnType<ProfileStore['getActive']>> & {};
  readonly backups: BackupStore;
  readonly archivePath: string;
  readonly mode: 'merge' | 'replace';
  readonly allowSecrets: boolean;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly onProgress?: (progress: number, step: string) => void;
}): Promise<{ preview: Awaited<ReturnType<BackupStore['restore']>>; safetySnapshot: Awaited<ReturnType<BackupStore['create']>>; process: ReturnType<ProcessSupervisor['getState']> }> {
  const { profile, backups, archivePath, mode, allowSecrets, supervisor, tunnel, onProgress } = options;
  const previousTunnelMode = tunnel.getState().mode;
  onProgress?.(5, 'Stopping SillyTavern');
  await tunnel.stop();
  await supervisor.stop();
  try {
    // A safety copy has to exist before the restore overwrites anything, but it
    // does not have to be a second copy of every file. Writing one compressed
    // archive is a single large sequential write; copying the tree file by file
    // measured 639 seconds on a ModelScope volume for the same data. It only
    // needs to carry secrets when the restore is going to overwrite them, and
    // an unchanged profile can reuse the backup it already has.
    onProgress?.(15, 'Creating safety snapshot');
    const incoming = await backups.preview(archivePath, profile.layout);
    const safetySnapshot = await backups.createSafetyCopy(profile, {
      name: `${profile.name}-prerestore`,
      includeSecrets: incoming.includesSecrets && allowSecrets,
      onProgress: ({ completed, total }) => onProgress?.(15 + (total > 0 ? (completed / total) * 10 : 0), `Backing up current data (${completed}/${total})`),
    });
    onProgress?.(25, 'Restoring data');
    const preview = await backups.restore(profile, archivePath, {
      mode,
      ...(allowSecrets ? { allowSecrets: true } : {}),
      onProgress: ({ completed, total }) => onProgress?.(25 + (total > 0 ? (completed / total) * 60 : 60), `Restoring files (${completed}/${total})`),
      onStatus: (step) => onProgress?.(RESTORE_STEP_PROGRESS[step] ?? 86, step),
    });
    onProgress?.(90, 'Starting SillyTavern');
    const process = await supervisor.start();
    if (previousTunnelMode !== 'off' && process.status === 'running') {
      onProgress?.(95, 'Starting public tunnel');
      await tunnel.restart();
    }
    onProgress?.(100, 'Restore complete');
    return { preview, safetySnapshot, process };
  } catch (error) {
    const process = await supervisor.start().catch(() => supervisor.getState());
    if (previousTunnelMode !== 'off' && process.status === 'running') await tunnel.restart().catch(() => undefined);
    throw error;
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

async function requireTunnelPassword(config: ConfigStore, profiles: ProfileStore, runtime: RuntimeManager, supervisor: ProcessSupervisor): Promise<void> {
  const state = await readAccessSecurityState(runtime, supervisor, profiles, config);
  if (!state.accountsEnabled || !state.adminPasswordConfigured) throw new RequestError(409, 'public_access_password_required', 'Set the SillyTavern admin password before opening a public tunnel');
}

async function requireAdminAccountPassword(runtime: RuntimeManager, supervisor: ProcessSupervisor, profiles: ProfileStore, config: ConfigStore): Promise<void> {
  const state = await readAccessSecurityState(runtime, supervisor, profiles, config);
  if (!state.accountsEnabled || !state.adminPasswordConfigured) throw new RequestError(409, 'public_access_password_required', 'Set the SillyTavern admin password before enabling network access');
}

async function readAccessSecurityState(runtime: RuntimeManager, supervisor: ProcessSupervisor | undefined, profiles: ProfileStore, config: ConfigStore): Promise<AccessSecurityState> {
  const profile = await profiles.getActive();
  const installation = await runtime.getActiveInstallation();
  if (!profile || !installation) return { accountsEnabled: false, adminHandle: 'default-user', adminPasswordConfigured: false, processReady: false };
  const document = await config.read(profile, installation);
  if (!document.settings.enableUserAccounts || !supervisor || supervisor.getState().status !== 'running') return { accountsEnabled: document.settings.enableUserAccounts, adminHandle: 'default-user', adminPasswordConfigured: false, processReady: supervisor?.getState().status === 'running' };
  try {
    const session = await createSillyTavernSession();
    const response = await fetch('http://127.0.0.1:8000/api/users/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.token },
      body: '{}',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok || response.status === 204) return { accountsEnabled: true, adminHandle: 'default-user', adminPasswordConfigured: false, processReady: true, error: 'SillyTavern account details are unavailable for this version or login configuration' };
    const users = await response.json() as Array<{ handle?: string; password?: boolean }>;
    const admin = users.find((user) => user.handle === 'default-user') ?? users[0];
    return { accountsEnabled: true, adminHandle: admin?.handle ?? 'default-user', adminPasswordConfigured: admin?.password === true, processReady: true };
  } catch {
    return { accountsEnabled: true, adminHandle: 'default-user', adminPasswordConfigured: false, processReady: false, error: 'SillyTavern account details are unavailable until SillyTavern is ready' };
  }
}

async function setSillyTavernAdminPassword(supervisor: ProcessSupervisor, runtime: RuntimeManager, profiles: ProfileStore, config: ConfigStore, password: string): Promise<void> {
  const state = await readAccessSecurityState(runtime, supervisor, profiles, config);
  if (!state.accountsEnabled || !state.processReady) throw new RequestError(409, 'sillytavern_not_running', 'Start SillyTavern before setting its admin password');
  if (state.error) throw new RequestError(409, 'sillytavern_accounts_unavailable', state.error);
  if (state.adminPasswordConfigured) {
    await resetSillyTavernAdminStorage(profiles, runtime, supervisor, state.adminHandle, password);
    return;
  }
  const session = await createSillyTavernSession();
  const login = await fetch('http://127.0.0.1:8000/api/users/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.token },
    body: JSON.stringify({ handle: state.adminHandle, password: '' }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!login.ok) throw new RequestError(502, 'sillytavern_auth_unavailable', 'SillyTavern rejected the initial admin session');
  const loginCookie = mergeCookies(session.cookie, responseCookies(login));
  const change = await fetch('http://127.0.0.1:8000/api/users/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: loginCookie, 'x-csrf-token': session.token },
    body: JSON.stringify({ handle: state.adminHandle, newPassword: password }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!change.ok) throw new RequestError(502, 'sillytavern_password_failed', 'SillyTavern could not save the admin password');
}

async function resetSillyTavernAdminStorage(profiles: ProfileStore, runtime: RuntimeManager, supervisor: ProcessSupervisor, handle: string, password: string): Promise<void> {
  const profile = await profiles.getActive();
  const installation = await runtime.getActiveInstallation();
  if (!profile || !installation) throw new RequestError(409, 'profile_required', 'An active SillyTavern profile is required');
  const storageRoots = [join(profile.dataPath, '_storage'), join(installation.runtimePath, 'data', '_storage'), join(installation.runtimePath, '_storage')];
  let recordPath: string | null = null;
  let record: Record<string, unknown> | null = null;
  for (const root of storageRoots) {
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    for (const name of names) {
      const path = join(root, name);
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(parsed) || parsed.key !== `user:${handle}` || !isRecord(parsed.value)) continue;
        recordPath = path;
        record = parsed;
        break;
      } catch { /* ignore unrelated node-persist records */ }
    }
    if (recordPath && record) break;
  }
  if (!recordPath || !record || !isRecord(record.value)) throw new RequestError(409, 'sillytavern_account_storage_unavailable', 'The SillyTavern account storage could not be found');
  const salt = randomBytes(16).toString('base64');
  record.value.password = scryptSync(password.normalize(), salt, 64).toString('base64');
  record.value.salt = salt;
  const temporary = `${recordPath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, recordPath);
  const restarted = await supervisor.restart();
  if (restarted.status !== 'running') throw new RequestError(502, 'sillytavern_restart_failed', 'SillyTavern could not restart after the password change');
}

interface SillyTavernSession {
  readonly token: string;
  readonly cookie: string;
}

async function createSillyTavernSession(): Promise<SillyTavernSession> {
  const response = await fetch('http://127.0.0.1:8000/csrf-token', { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new RequestError(502, 'sillytavern_auth_unavailable', 'SillyTavern did not provide an authentication session');
  const body = await response.json() as { token?: string };
  const cookie = responseCookies(response);
  if (!body.token || (!cookie && body.token !== 'disabled')) throw new RequestError(502, 'sillytavern_auth_unavailable', 'SillyTavern did not provide an authentication session');
  return { token: body.token, cookie };
}

function responseCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

function mergeCookies(...values: string[]): string {
  const cookies = new Map<string, string>();
  for (const value of values) {
    for (const pair of value.split(';')) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      cookies.set(pair.slice(0, separator).trim(), pair.trim());
    }
  }
  return [...cookies.values()].join('; ');
}

async function configUpdateEnablesListen(input: ConfigUpdateInput, config: ConfigStore): Promise<boolean> {
  if (input.settings?.listen === true) return true;
  if (input.rawYaml !== undefined) return (await config.validate(input.rawYaml)).listen;
  return false;
}

function parseConfigUpdateInput(value: unknown): ConfigUpdateInput {
  if (!isRecord(value)) throw new RequestError(400, 'invalid_input', 'A configuration update is required');
  if (typeof value.rawYaml === 'string') return { rawYaml: value.rawYaml };
  const settings = value.settings;
  if (!isRecord(settings)) throw new RequestError(400, 'invalid_input', 'Configuration settings are required');
  return { settings: {
    ...(typeof settings.listen === 'boolean' ? { listen: settings.listen } : {}),
    ...(typeof settings.enableUserAccounts === 'boolean' ? { enableUserAccounts: settings.enableUserAccounts } : {}),
    ...(typeof settings.sslEnabled === 'boolean' ? { sslEnabled: settings.sslEnabled } : {}),
    ...(typeof settings.enableCorsProxy === 'boolean' ? { enableCorsProxy: settings.enableCorsProxy } : {}),
    ...(typeof settings.disableCsrfProtection === 'boolean' ? { disableCsrfProtection: settings.disableCsrfProtection } : {}),
    ...(isRecord(settings.listenAddress) ? { listenAddress: {
      ...(typeof settings.listenAddress.ipv4 === 'string' ? { ipv4: settings.listenAddress.ipv4 } : {}),
      ...(typeof settings.listenAddress.ipv6 === 'string' ? { ipv6: settings.listenAddress.ipv6 } : {}),
    } } : {}),
  } };
}

function decorateConfig(document: Awaited<ReturnType<ConfigStore['read']>>): Awaited<ReturnType<ConfigStore['read']>> {
  const host = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []).find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  return host ? { ...document, networkHost: host } : document;
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

  public constructor(private readonly logBuffer = new LogBuffer()) {}

  public append(source: LogEntry['source'], message: string, level: LogEntry['level'] = 'info'): void {
    this.logBuffer.append(source, message, level);
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
      installationId,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  public createOperation(kind: 'backup' | 'restore', step: string): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job-${randomUUID()}`,
      kind,
      state: 'running',
      progress: 0,
      step,
      installationId: null,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

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
    this.jobs.set(id, { ...current, progress: progress.progress, step: progress.step, updatedAt: new Date().toISOString() });
  }

  public finish(installationId: string, state: 'succeeded' | 'failed', error: string | null): void {
    const id = `job-${installationId}`;
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, state, progress: state === 'succeeded' ? 100 : current.progress, step: state === 'succeeded' ? 'Installation ready' : 'Installation failed', error, updatedAt: new Date().toISOString() });
  }

  public updateOperation(id: string, progress: number, step: string): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, progress: Math.max(0, Math.min(100, Math.round(progress))), step, updatedAt: new Date().toISOString() });
  }

  public finishOperation(id: string, state: 'succeeded' | 'failed', error: string | null): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, state, progress: state === 'succeeded' ? 100 : current.progress, step: state === 'succeeded' ? 'Completed' : 'Failed', error, updatedAt: new Date().toISOString() });
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
  manager: MANAGER_PORT,
  sillyTavern: SILLYTAVERN_PORT,
};

export const minimumAdminPasswordLength = MIN_PASSWORD_LENGTH;
