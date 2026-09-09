import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { StateStore } from '../src/state.js';
import { startManagerServer, type ManagerServer } from '../src/server.js';

async function createServer(options: { setupCodeRequired?: boolean; bootstrapPassword?: string } = {}): Promise<ManagerServer> {
  const root = await mkdtemp(join(tmpdir(), 'stm-manager-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
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
  assert.equal(protectedResponse.status, 501);

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
