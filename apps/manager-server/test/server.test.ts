import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { StateStore } from '../src/state.js';
import { startManagerServer, type ManagerServer } from '../src/server.js';
import type { Installation, ProcessState, VersionOption } from '../../../packages/contracts/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
import type { ProcessSupervisor } from '../src/supervisor.js';

async function createServer(options: { setupCodeRequired?: boolean; bootstrapPassword?: string; platform?: 'linux' | 'modelscope' } = {}): Promise<ManagerServer> {
  const root = await mkdtemp(join(tmpdir(), 'stm-manager-'));
  const basePaths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const paths = options.platform === 'modelscope' ? { ...basePaths, platform: 'modelscope' as const } : basePaths;
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  const store = new StateStore({ paths, setupCode: 'setup-test-code' });
  return startManagerServer({
    host: '127.0.0.1',
    port: 0,
    paths,
    store,
    setupCodeRequired: options.setupCodeRequired ?? true,
    env: options.bootstrapPassword ? { STM_ADMIN_PASSWORD: options.bootstrapPassword } : {},
    secureCookies: false,
    staticRoot,
    logger: () => undefined,
  });
}

test('ModelScope proxy origins are accepted while unrelated origins remain blocked', async (t) => {
  const manager = await createServer({ platform: 'modelscope', bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const proxied = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://www.modelscope.ai' } });
  assert.equal(proxied.status, 200);
  const studioFrame = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://locmay-stm.ms.fun' } });
  assert.equal(studioFrame.status, 200);
  const unrelated = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(unrelated.status, 403);
  assert.equal((await unrelated.json() as { error: { code: string } }).error.code, 'origin_rejected');
});

function serverUrl(manager: ManagerServer): string {
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header);
  const match = /stm_session=[^;]+/.exec(header);
  assert.ok(match);
  return match[0];
}

test('setup, login, CSRF, health, and logout work on the manager port', async (t) => {
  const manager = await createServer();
  t.after(() => manager.close());
  const base = serverUrl(manager);

  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { manager: { port: number } }).manager.port, 7860);

  const panel = await fetch(`${base}/`);
  assert.equal(panel.status, 200);
  assert.match(panel.headers.get('content-type') ?? '', /text\/html/);

  const setupStatus = await fetch(`${base}/api/v1/setup/status`);
  assert.equal(setupStatus.status, 200);
  assert.equal((await setupStatus.json() as { setupRequired: boolean; setupCodeRequired: boolean }).setupCodeRequired, true);

  const setup = await fetch(`${base}/api/v1/setup/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple', setupCode: 'setup-test-code', termsAccepted: true, telemetryAccepted: true }),
  });
  assert.equal(setup.status, 201);
  const setupBody = await setup.json() as { session: { csrfToken: string } };
  const cookie = cookieFrom(setup);

  const unauthenticated = await fetch(`${base}/api/v1/profiles`);
  assert.equal(unauthenticated.status, 401);
  const protectedResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  assert.equal(protectedResponse.status, 200);
  assert.deepEqual((await protectedResponse.json() as { profiles: unknown[] }).profiles, []);
  await manager.metrics.append({ schemaVersion: 1, timestamp: new Date().toISOString(), provider: 'openai', model: 'gpt-test', endpointHost: 'api.openai.com', stream: false, maxTokens: 128, inputTokens: 4, outputTokens: 6, totalTokens: 10, status: 200, durationMs: 25 });
  const metricsResponse = await fetch(`${base}/api/v1/metrics?days=7`, { headers: { cookie } });
  assert.equal(metricsResponse.status, 200);
  assert.equal((await metricsResponse.json() as { totals: { requests: number; totalTokens: number } }).totals.requests, 1);
  const missingProfileActivation = await fetch(`${base}/api/v1/profiles/missing/activate`, { method: 'POST', headers: { cookie, 'x-csrf-token': setupBody.session.csrfToken } });
  assert.equal(missingProfileActivation.status, 404);
  assert.equal((await missingProfileActivation.json() as { error: { code: string } }).error.code, 'profile_not_found');

  const csrfFailure = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(csrfFailure.status, 403);
  const logout = await fetch(`${base}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': setupBody.session.csrfToken },
  });
  assert.equal(logout.status, 200);

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  assert.ok(cookieFrom(login));
});

test('STM_ADMIN_PASSWORD bootstraps a fresh installation without exposing the password', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const status = await fetch(`${base}/api/v1/setup/status`);
  assert.equal((await status.json() as { setupRequired: boolean }).setupRequired, false);
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const payload = await login.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(payload).includes('correct horse'), false);
});

test('a fresh manager without an environment secret accepts first-run password setup', async (t) => {
  const manager = await createServer({ setupCodeRequired: false });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const setup = await fetch(`${base}/api/v1/setup/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '123456', termsAccepted: true, telemetryAccepted: true }),
  });
  assert.equal(setup.status, 201);
});

test('authenticated admins can change the manager password without losing persistence', async (t) => {
  const manager = await createServer({ bootstrapPassword: '123456' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const changed = await fetch(`${base}/api/v1/auth/password`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ password: '654321', confirmPassword: '654321' }) });
  assert.equal(changed.status, 200);
  const oldLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '654321' }) });
  assert.equal(newLogin.status, 200);
});

test('R2 settings are authenticated, masked, and preserve masked credentials', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const saved = await fetch(`${base}/api/v1/r2`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:9999', bucket: 'stm-test-bucket', accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678' }) });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { config: { configured: boolean; accessKeyIdMasked: string; secretAccessKeyConfigured: boolean } };
  assert.equal(savedBody.config.configured, true);
  assert.equal(savedBody.config.accessKeyIdMasked, 'ac********34');
  assert.equal(savedBody.config.secretAccessKeyConfigured, true);
  const preserved = await fetch(`${base}/api/v1/r2`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ accessKeyId: '********', secretAccessKey: '********' }) });
  assert.equal(preserved.status, 200);
  const visible = await fetch(`${base}/api/v1/r2`, { headers: { cookie } });
  const visibleText = await visible.text();
  assert.equal(visible.status, 200);
  assert.equal(visibleText.includes('secret-key-5678'), false);
  assert.equal(visibleText.includes('access-key-1234'), false);
});

test('config follows the active runtime and account mode gates public access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-config-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(join(runtimePath, 'src'), { recursive: true });
  // 1.18 has user accounts, and the store tells versions apart by this file.
  await writeFile(join(runtimePath, 'src', 'users.js'), 'export const users = true;', 'utf8');
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.18.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const processState: ProcessState = { status: 'running', installationId: installation.id, profileId: 'profile-1', pid: 123, startedAt: now, error: null };
  const fakeSupervisor = { getState: () => processState, restart: async () => processState, start: async () => processState, stop: async () => ({ ...processState, status: 'stopped' }), close: async () => undefined } as unknown as ProcessSupervisor;
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation, getInstallation: async (id: string) => id === installation.id ? installation : null } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilePayload = await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ configPath: string }> };
  const profile = profilePayload.profiles[0]; assert.ok(profile);
  await writeFile(profile.configPath, '# current version config\nlisten: false\nport: 8000\nbasicAuthMode: true\nbasicAuthUser:\n  username: user\n  password: old-secret\n', 'utf8');
  const visible = await fetch(`${base}/api/v1/config`, { headers: { cookie } });
  assert.equal(visible.status, 200);
  const visibleBody = await visible.json() as { runtimeRef: string; rawYaml: string; settings: { listen: boolean; enableUserAccounts: boolean } };
  assert.equal(visibleBody.runtimeRef, '1.18.0');
  assert.equal(visibleBody.settings.enableUserAccounts, false);
  assert.match(visibleBody.rawYaml, /basicAuthUser:/u);
  assert.equal(visibleBody.rawYaml.includes('old-secret'), false);
  const blocked = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick' }) });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'public_access_password_required');
  const saved = await fetch(`${base}/api/v1/config`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ settings: { listen: false } }) });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { config: { rawYaml: string; settings: { listen: boolean; enableUserAccounts: boolean } } };
  assert.equal(savedBody.config.settings.listen, false);
  assert.equal(savedBody.config.settings.enableUserAccounts, true);
  assert.match(savedBody.config.rawYaml, /basicAuthMode: false/u);
  assert.match(savedBody.config.rawYaml, /basicAuthUser:/u);
  assert.equal(savedBody.config.rawYaml.includes('old-secret'), false);
});

test('only one concurrent first-run setup can create the admin', async (t) => {
  const manager = await createServer();
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const payload = JSON.stringify({ password: 'correct horse battery staple', setupCode: 'setup-test-code', termsAccepted: true, telemetryAccepted: true });
  const responses = await Promise.all([
    fetch(`${base}/api/v1/setup/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }),
    fetch(`${base}/api/v1/setup/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort((left, right) => left - right), [201, 409]);
});

test('authenticated installation endpoints return versions and a pollable job', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-runtime-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath: join(root, 'runtime'), markerPath: join(root, 'runtime', '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const versions: VersionOption[] = [{ selector: 'latest', label: '1.2.3', ref: '1.2.3', channel: 'release', tag: '1.2.3', publishedAt: now }];
  const fakeRuntime = {
    listVersions: async () => versions,
    listInstallations: async () => [installation],
    getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
    queueInstall: () => ({ id: 'install-2', promise: Promise.resolve(installation) }),
  } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const list = await fetch(`${base}/api/v1/versions`, { headers: { cookie } });
  assert.deepEqual((await list.json() as { versions: VersionOption[] }).versions, versions);
  const create = await fetch(`${base}/api/v1/installations`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(create.status, 202);
  const jobId = (await create.json() as { job: { id: string } }).job.id;
  const job = await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  assert.equal(job.status, 200);
  const allLogs = await fetch(`${base}/api/v1/logs?source=all&after=0`, { headers: { cookie } });
  assert.equal(allLogs.status, 200);
  const allLogEntries = (await allLogs.json() as { entries: Array<{ source: string }> }).entries;
  assert.ok(allLogEntries.some((entry) => entry.source === 'manager'));
  const invalidLogs = await fetch(`${base}/api/v1/logs?source=unknown&after=0`, { headers: { cookie } });
  assert.equal(invalidLogs.status, 400);
  const process = await fetch(`${base}/api/v1/process`, { headers: { cookie } });
  assert.equal(process.status, 200);
  assert.ok(['stopped', 'error'].includes((await process.json() as { status: string }).status));
  const processStart = await fetch(`${base}/api/v1/process/start`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(processStart.status, 200);
  assert.equal((await processStart.json() as { status: string }).status, 'error');
  const tunnelStart = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick' }) });
  assert.equal(tunnelStart.status, 409);
});

test('local backup endpoints create, preview, download, and restore a profile archive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-backup-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = {
    listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
  } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilesResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  const profile = (await profilesResponse.json() as { profiles: Array<{ dataPath: string; configPath: string }> }).profiles[0];
  assert.ok(profile);
  const profileDataRoot = join(profile.dataPath, 'default-user');
  await mkdir(profileDataRoot, { recursive: true });
  await writeFile(join(profileDataRoot, 'settings.json'), '{"theme":"dark"}', 'utf8');
  await writeFile(profile.configPath, 'listen: false\n', 'utf8');
  const create = await fetch(`${base}/api/v1/backups`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(create.status, 202);
  const createJob = await create.json() as { jobId: string };
  let manifest: { id: string; fileCount: number } | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/${createJob.jobId}`, { headers: { cookie } });
    const job = await jobResponse.json() as { state: string; error?: string };
    if (job.state === 'succeeded') {
      const backupsResponse = await fetch(`${base}/api/v1/backups`, { headers: { cookie } });
      manifest = (await backupsResponse.json() as { backups: Array<{ id: string; fileCount: number }> }).backups[0] ?? null;
      break;
    }
    if (job.state === 'failed') throw new Error(job.error ?? 'backup job failed');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.ok(manifest);
  assert.equal(manifest.fileCount, 2);
  const preview = await fetch(`${base}/api/v1/backups/${manifest.id}/preview`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json() as { fileCount: number }).fileCount, 2);
  const download = await fetch(`${base}/api/v1/backups/${manifest.id}/download`, { headers: { cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /application\/zip/);
  const archiveBytes = await download.arrayBuffer();
  const importedPreview = await fetch(`${base}/api/v1/backups/import/preview`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/zip' }, body: archiveBytes });
  assert.equal(importedPreview.status, 200);
  const importedBody = await importedPreview.json() as { fileCount: number; backup: { id: string; source: string } };
  assert.equal(importedBody.fileCount, 2);
  assert.equal(importedBody.backup.source, 'uploaded');
  const chunkUploadId = 'server-chunk-upload-1';
  const bytes = new Uint8Array(archiveBytes);
  const split = Math.max(1, Math.ceil(bytes.length / 2));
  for (let index = 0; index < 2; index += 1) {
    const chunk = await fetch(`${base}/api/v1/backups/import/chunk?uploadId=${chunkUploadId}&index=${index}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, body: bytes.slice(index * split, Math.min(bytes.length, (index + 1) * split)) });
    assert.equal(chunk.status, 200);
  }
  const finishedUpload = await fetch(`${base}/api/v1/backups/import/finish`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: chunkUploadId, name: 'chunked-upload.zip', expectedBytes: bytes.length }) });
  assert.equal(finishedUpload.status, 200);
  const chunkedBody = await finishedUpload.json() as { backup: { id: string; source: string } };
  assert.equal(chunkedBody.backup.source, 'uploaded');
  const removedChunked = await fetch(`${base}/api/v1/backups/${chunkedBody.backup.id}`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(removedChunked.status, 200);
  const renamed = await fetch(`${base}/api/v1/backups/${importedBody.backup.id}`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Uploaded copy' }) });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json() as { name: string }).name, 'Uploaded copy.zip');
  const listed = await fetch(`${base}/api/v1/backups`, { headers: { cookie } });
  assert.equal((await listed.json() as { backups: unknown[] }).backups.length, 2);
  const removed = await fetch(`${base}/api/v1/backups/${importedBody.backup.id}`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(removed.status, 200);
  const restore = await fetch(`${base}/api/v1/backups/${manifest.id}/restore`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'replace' }) });
  assert.equal(restore.status, 202);
  const restoreJob = await restore.json() as { jobId: string };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/${restoreJob.jobId}`, { headers: { cookie } });
    const job = await jobResponse.json() as { state: string; error?: string };
    if (job.state === 'succeeded') break;
    if (job.state === 'failed') throw new Error(job.error ?? 'restore job failed');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(await readFile(join(profile.dataPath, 'default-user', 'settings.json'), 'utf8'), '{"theme":"dark"}');
});

test('installing a new version rebinds the active data profile and keeps its files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-version-profile-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const oldRuntime = join(root, 'old-runtime'); const newRuntime = join(root, 'new-runtime');
  await mkdir(oldRuntime, { recursive: true }); await mkdir(newRuntime, { recursive: true });
  const now = new Date().toISOString();
  const oldInstallation: Installation = { id: 'install-old', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath: oldRuntime, markerPath: join(oldRuntime, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const newInstallation: Installation = { ...oldInstallation, id: 'install-new', resolvedRef: '2.0.0', runtimePath: newRuntime, markerPath: join(newRuntime, '.stm-installation.json') };
  await writeFile(newInstallation.markerPath, '{}', 'utf8');
  let activeInstallation = oldInstallation;
  const fakeRuntime = {
    listVersions: async () => [], listInstallations: async () => [oldInstallation, newInstallation], getActiveInstallation: async () => activeInstallation,
    getInstallation: async (id: string) => id === oldInstallation.id ? oldInstallation : id === newInstallation.id ? newInstallation : null,
    queueInstall: () => ({ id: newInstallation.id, promise: Promise.resolve(newInstallation).then((installation) => { activeInstallation = installation; return installation; }) }),
  } as unknown as RuntimeManager;
  let processState: ProcessState = { status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null };
  const fakeSupervisor = {
    getState: () => processState,
    start: async () => { processState = { ...processState, status: 'running', installationId: newInstallation.id }; return processState; },
    stop: async () => { processState = { ...processState, status: 'stopped' }; return processState; },
    restart: async () => processState,
    close: async () => undefined,
  } as unknown as ProcessSupervisor;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilesResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  const profile = (await profilesResponse.json() as { profiles: Array<{ id: string; dataPath: string; installationId: string }> }).profiles[0];
  assert.ok(profile);
  await writeFile(join(profile.dataPath, 'chat.json'), '{"message":"keep"}', 'utf8');
  const installResponse = await fetch(`${base}/api/v1/installations`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(installResponse.status, 202);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/${newInstallation.id}`, { headers: { cookie } });
    if (jobResponse.ok && (await jobResponse.json() as { state: string }).state === 'succeeded') break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const afterResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  const afterBody = await afterResponse.text();
  assert.equal(afterResponse.status, 200, afterBody);
  const after = (JSON.parse(afterBody) as { profiles: Array<{ installationId: string; dataPath: string }> }).profiles[0];
  assert.equal(after?.installationId, newInstallation.id);
  assert.equal(after?.dataPath, profile.dataPath);
  assert.equal(await readFile(join(profile.dataPath, 'chat.json'), 'utf8'), '{"message":"keep"}');
});

test('a failed install that also fails to restart leaves the manager serving', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-recovery-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = {
    listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
    queueInstall: () => ({ id: 'install-2', promise: Promise.reject(new Error('the download failed')) }),
  } as unknown as RuntimeManager;
  // Recovery runs because the install already failed, and here it fails too -
  // which used to reject with nobody listening and end the manager process.
  const processState: ProcessState = { status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null };
  const fakeSupervisor = {
    getState: () => processState,
    start: async () => { throw new Error('the runtime will not start'); },
    stop: async () => processState,
    restart: async () => { throw new Error('the runtime will not start'); },
    close: async () => undefined,
  } as unknown as ProcessSupervisor;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const installResponse = await fetch(`${base}/api/v1/installations`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(installResponse.status, 202);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/install-2`, { headers: { cookie } });
    if (jobResponse.ok && (await jobResponse.json() as { state: string }).state === 'failed') break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  // The console is what the operator installs a different version from, so it
  // has to answer after all of that.
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  const versions = await fetch(`${base}/api/v1/installations`, { headers: { cookie } });
  assert.equal(versions.status, 200);
});

test('a SillyTavern without user accounts can still be given a password and shared', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-legacy-access-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  // No src/users.js and no default/config.yaml: this is a pre-1.12 runtime.
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: '1.11.0', resolvedRef: '1.11.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const processState: ProcessState = { status: 'running', installationId: installation.id, profileId: 'profile-1', pid: 321, startedAt: now, error: null };
  const fakeSupervisor = { getState: () => processState, restart: async () => processState, start: async () => processState, stop: async () => ({ ...processState, status: 'stopped' }), close: async () => undefined } as unknown as ProcessSupervisor;
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation, getInstallation: async (id: string) => id === installation.id ? installation : null } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilePayload = await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ configPath: string }> };
  const profile = profilePayload.profiles[0];
  assert.ok(profile);
  await writeFile(profile.configPath, 'listen: false\nport: 8000\nbasicAuthMode: false\nbasicAuthUser:\n  username: user\n  password: password\n', 'utf8');

  const before = await (await fetch(`${base}/api/v1/access/security`, { headers: { cookie } })).json() as { mode: string; adminPasswordConfigured: boolean; error?: string };
  assert.equal(before.mode, 'basicAuth');
  assert.equal(before.adminPasswordConfigured, false);
  assert.equal(before.error, undefined, 'nothing is waiting on SillyTavern here, so there is nothing to report');

  const saved = await fetch(`${base}/api/v1/access/password`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'a-real-secret', confirmPassword: 'a-real-secret' }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as { adminPasswordConfigured: boolean }).adminPasswordConfigured, true);
  assert.match(await readFile(profile.configPath, 'utf8'), /basicAuthMode: true/u);

  // The tunnel refuses to open without a password; Basic Auth is one.
  const allowed = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick' }) });
  assert.notEqual(allowed.status, 409);
});

test('a running backup can be stopped, and a finished one cannot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-stop-job-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation, getInstallation: async (id: string) => id === installation.id ? installation : null } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profile = (await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ dataPath: string }> }).profiles[0];
  assert.ok(profile);
  // Enough files that the stop lands while the archive is still being written.
  const dataRoot = join(profile.dataPath, 'default-user');
  await mkdir(dataRoot, { recursive: true });
  for (let index = 0; index < 600; index += 1) {
    await writeFile(join(dataRoot, `note-${index}.json`), JSON.stringify({ index, filler: 'x'.repeat(8192) }), 'utf8');
  }

  const started = await fetch(`${base}/api/v1/backups`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 202);
  const { jobId } = await started.json() as { jobId: string };
  const stopped = await fetch(`${base}/api/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(stopped.status, 200);

  const deadline = Date.now() + 15_000;
  let job = await (await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } })).json() as { state: string; error: string | null };
  while (job.state === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = await (await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } })).json() as { state: string; error: string | null };
  }
  assert.equal(job.state, 'canceled');
  assert.equal(job.error, null, 'the operator stopping the work is not an error to report');
  // A stopped backup leaves no half-written entry in the library.
  assert.deepEqual((await (await fetch(`${base}/api/v1/backups`, { headers: { cookie } })).json() as { backups: unknown[] }).backups, []);

  const again = await fetch(`${base}/api/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(again.status, 409);
  const missing = await fetch(`${base}/api/v1/jobs/job-nothing/cancel`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(missing.status, 404);
});

test('the launcher shutdown route exists only for the launcher that started the manager', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-shutdown-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  let asked = 0;
  const manager = await startManagerServer({
    host: '127.0.0.1',
    port: 0,
    paths,
    env: { STM_ADMIN_PASSWORD: 'correct horse battery staple', STM_SHUTDOWN_TOKEN: 'launcher-secret' },
    secureCookies: false,
    logger: () => undefined,
    onShutdownRequest: () => { asked += 1; },
  });
  t.after(() => manager.close());
  const base = serverUrl(manager);

  // Nothing on the machine that has not been told the token can reach it, and
  // it is not even visible as a route to anything that has not.
  const anonymous = await fetch(`${base}/api/v1/shutdown`, { method: 'POST' });
  assert.equal(anonymous.status, 404);
  const wrong = await fetch(`${base}/api/v1/shutdown`, { method: 'POST', headers: { 'x-stm-shutdown-token': 'guess' } });
  assert.equal(wrong.status, 404);
  assert.equal(asked, 0);

  const right = await fetch(`${base}/api/v1/shutdown`, { method: 'POST', headers: { 'x-stm-shutdown-token': 'launcher-secret' } });
  assert.equal(right.status, 202);
  assert.equal(asked, 1);
});

test('no launcher token means no shutdown route at all', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const response = await fetch(`${serverUrl(manager)}/api/v1/shutdown`, { method: 'POST', headers: { 'x-stm-shutdown-token': 'anything' } });
  assert.equal(response.status, 404);
});
