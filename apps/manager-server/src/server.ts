import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { ApiErrorBody, HealthResponse, Installation, Job, LogEntry, LogSourceFilter, ManagerPorts, ProfileLayout, SetupStatus, VersionSelector } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, type PlatformPaths } from '../../../packages/platform/src/index.js';
import { RuntimeError, RuntimeManager, type InstallationProgress } from '../../../packages/sillytavern-runtime/src/index.js';
import { hashPassword, MIN_PASSWORD_LENGTH, validatePassword, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { parseSessionCookie, SessionStore, clearSessionCookie, sessionCookie } from './sessions.js';
import { hashSetupCode, StateStore } from './state.js';
import { LogBuffer } from './log-buffer.js';
import { ProcessSupervisor } from './supervisor.js';
import { TunnelManager } from '../../../packages/tunnel/src/index.js';
import { ProfileError, ProfileStore } from '../../../packages/profiles/src/index.js';
import { BackupError, BackupStore } from '../../../packages/backup/src/index.js';

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
  '/api/v1/metrics',
  '/api/v1/tunnel',
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
  const supervisor = options.supervisor ?? new ProcessSupervisor({
    runtime,
    profileResolver: (installation) => profiles.getActiveForInstallation(installation.id),
    profileLifecycle: {
      prepare: (profile, runtimePath) => profiles.prepareForRuntime(profile, runtimePath),
      persist: (profile, runtimePath, runtimeLayout) => profiles.persistFromRuntime(profile, runtimePath, runtimeLayout),
      legacyHeapMb: (profile) => profiles.recommendedLegacyHeapMb(profile),
    },
    logger: (line) => { jobs.append('sillytavern', line); baseLogger(line); },
  });
  const tunnel = options.tunnel ?? new TunnelManager({ paths, env, logger: (line) => { jobs.append('cloudflared', line); baseLogger(line); } });
  const secureCookies = options.secureCookies ?? env.STM_SECURE_COOKIES === '1';
  const setupCodeRequired = options.setupCodeRequired ?? requiresSetupCode(env);
  const staticRoot = resolve(options.staticRoot ?? join(process.cwd(), 'apps', 'manager-panel', 'dist'));
  let persisted = await store.load();

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
      logger,
      runtime,
      jobs,
      supervisor,
      tunnel,
      profiles,
      backups,
    }).catch((error: unknown) => {
      if (error instanceof RequestError) {
        sendError(response, error.statusCode, error.code, error.message);
        return;
      }
      if (error instanceof BackupError) {
        sendError(response, error.code === 'secrets_confirmation_required' ? 409 : 400, error.code, error.message);
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
    close: async () => { await tunnel.close(); await supervisor.close(); await closeServer(server); },
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
  readonly logger: (line: string) => void;
  readonly runtime: RuntimeManager;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
}): Promise<void> {
  const { request, response, store, sessions, rateLimiter, startedAt, secureCookies, setupCodeRequired, staticRoot, runtime, jobs, supervisor, tunnel, profiles, backups } = options;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const context: RequestContext = {
    request,
    response,
    pathname,
    originTrusted: isTrustedOrigin(request),
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
    await handleRuntimeRequest(context, runtime, jobs, supervisor, tunnel, profiles, backups);
    return;
  }

  sendError(response, 404, 'not_found', 'Route not found');
}

async function handleRuntimeRequest(context: RequestContext, runtime: RuntimeManager, jobs: JobStore, supervisor: ProcessSupervisor, tunnel: TunnelManager, profiles: ProfileStore, backups: BackupStore): Promise<void> {
  const { pathname, request, response } = context;
  const method = request.method ?? 'GET';
  if (pathname === '/api/v1/logs' && method === 'GET') {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const afterValue = Number(url.searchParams.get('after') ?? 0);
    const sourceParam = url.searchParams.get('source') ?? 'all';
    if (!Number.isSafeInteger(afterValue) || afterValue < 0) { sendError(response, 400, 'invalid_cursor', 'The log cursor is invalid'); return; }
    if (!isLogSourceFilter(sourceParam)) { sendError(response, 400, 'invalid_source', 'The log source is invalid'); return; }
    const result = jobs.logs(afterValue, sourceParam === 'all' ? null : sourceParam);
    sendJson(response, 200, result);
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
    const manifest = await backups.create(profile, {
      ...(name ? { name } : {}),
      ...(includeSecrets ? { includeSecrets: true } : {}),
    });
    sendJson(response, 201, manifest);
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
      const result = await restoreWithProcess({ profile, backups, archivePath: libraryPath, mode, allowSecrets, profiles, supervisor, tunnel });
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
      const result = await restoreWithProcess({ profile, backups, archivePath, mode, allowSecrets, profiles, supervisor, tunnel });
      sendJson(response, 200, result);
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
    const state = mode === 'off' ? await tunnel.stop() : await tunnel.start(mode, isRecord(body) && typeof body.token === 'string' ? body.token : undefined);
    sendJson(response, 200, state);
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

async function restoreWithProcess(options: {
  readonly profile: Awaited<ReturnType<ProfileStore['getActive']>> & {};
  readonly backups: BackupStore;
  readonly archivePath: string;
  readonly mode: 'merge' | 'replace';
  readonly allowSecrets: boolean;
  readonly profiles: ProfileStore;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
}): Promise<{ preview: Awaited<ReturnType<BackupStore['restore']>>; safetySnapshot: Awaited<ReturnType<ProfileStore['createSafetySnapshot']>>; process: ReturnType<ProcessSupervisor['getState']> }> {
  const { profile, backups, archivePath, mode, allowSecrets, profiles, supervisor, tunnel } = options;
  const previousTunnelMode = tunnel.getState().mode;
  await tunnel.stop();
  await supervisor.stop();
  try {
    const safetySnapshot = await profiles.createSafetySnapshot(profile);
    const preview = await backups.restore(profile, archivePath, { mode, ...(allowSecrets ? { allowSecrets: true } : {}) });
    const process = await supervisor.start();
    if (previousTunnelMode !== 'off' && process.status === 'running') await tunnel.restart();
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
    || pathname.startsWith('/api/v1/backups/');
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

function isTrustedOrigin(request: IncomingMessage): boolean {
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
    return Boolean(host && parsed.host === host);
  } catch {
    return false;
  }
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
  return env.STM_REQUIRE_SETUP_CODE === '1'
    || env.STM_MODELSCOPE === '1'
    || env.STM_MODELSCOPE?.toLowerCase() === 'true'
    || Boolean(env.MODELSCOPE_HOST || env.MODELSCOPE_ENVIRONMENT);
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

  public get(id: string): Job | null { return this.jobs.get(id) ?? null; }

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
