import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeState, DEFAULT_SCOPES } from '../../../packages/cloudflare/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { CloudflareConnection } from '../../../packages/r2/src/index.js';
import { ACCOUNT_ID, fakeCloudflare, OTHER_ACCOUNT_ID, type FakeCloudflareState } from '../../../packages/r2/test/cloudflare-fake.js';
import { CLOUDFLARE_CALLBACK_PATH, startManagerServer, type ManagerServer } from '../src/server.js';

const PASSWORD = 'correct horse battery staple';

async function start(options: { cloudflare?: Partial<FakeCloudflareState> | null } = {}): Promise<{ manager: ManagerServer; base: string; state: FakeCloudflareState | null }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-cf-routes-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  let connection: CloudflareConnection | null = null;
  let state: FakeCloudflareState | null = null;
  if (options.cloudflare !== null) {
    const fake = await fakeCloudflare(options.cloudflare ?? {});
    state = fake.state;
    connection = new CloudflareConnection({
      paths,
      client: { clientId: 'client-1', redirectUri: 'http://localhost:7860/oauth/cloudflare/callback', scopes: Object.values(DEFAULT_SCOPES) },
      fetchImpl: fake.fetchImpl,
      sleep: async () => undefined,
    });
  }
  const manager = await startManagerServer({
    host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: PASSWORD }, secureCookies: false, accessPort: 0, staticRoot,
    logger: () => undefined, cloudflare: connection,
  });
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return { manager, base: `http://127.0.0.1:${address.port}`, state };
}

async function signIn(base: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(response.status, 200);
  const cookie = /stm_session=[^;]+/u.exec(response.headers.get('set-cookie') ?? '')?.[0];
  assert.ok(cookie);
  return { cookie, csrf: (await response.json() as { session: { csrfToken: string } }).session.csrfToken };
}

async function beginConnect(base: string, auth: { cookie: string; csrf: string }): Promise<string> {
  const response = await fetch(`${base}/api/v1/r2/cloudflare/connect`, { method: 'POST', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: base } });
  assert.equal(response.status, 200);
  const url = new URL((await response.json() as { url: string }).url);
  const state = url.searchParams.get('state') ?? '';
  assert.equal(decodeState(state)?.returnOrigin, base, 'the relay is told to come back to the origin the panel is open on');
  return state;
}

function callback(base: string, query: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${base}${CLOUDFLARE_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`, { redirect: 'manual', ...(cookie ? { headers: { cookie } } : {}) });
}

interface ConfigBody { config: { mode: string; enabled: boolean; configured: boolean; cloudflare: { state: string; bucket: string | null; dataPath: string | null } | null } }

test('signing in to Cloudflare connects the backup bucket end to end, and disconnecting switches R2 off', async (t) => {
  const { manager, base, state } = await start();
  t.after(() => manager.close());
  assert.equal((await fetch(`${base}/api/v1/r2/cloudflare`)).status, 401);
  const auth = await signIn(base);

  const before = await (await fetch(`${base}/api/v1/r2`, { headers: { cookie: auth.cookie } })).json() as ConfigBody;
  assert.equal(before.config.mode, 'keys');
  assert.equal(before.config.cloudflare?.state, 'disconnected');

  const csrfless = await fetch(`${base}/api/v1/r2/cloudflare/connect`, { method: 'POST', headers: { cookie: auth.cookie, origin: base } });
  assert.equal(csrfless.status, 403);

  const stateParam = await beginConnect(base, auth);
  // Without the admin's session the callback cannot finish, and says why.
  const anonymous = await callback(base, { state: stateParam, code: 'good-code' });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/?cloudflare=error&cloudflare_error=login_required#data');

  const landed = await callback(base, { state: stateParam, code: 'good-code' }, auth.cookie);
  assert.equal(landed.status, 303);
  assert.equal(landed.headers.get('location'), '/?cloudflare=connected#data');
  assert.equal(landed.headers.get('referrer-policy'), 'no-referrer');

  const connected = await (await fetch(`${base}/api/v1/r2`, { headers: { cookie: auth.cookie } })).json() as ConfigBody;
  assert.equal(connected.config.mode, 'cloudflare');
  assert.equal(connected.config.enabled, true);
  assert.equal(connected.config.configured, true);
  assert.equal(connected.config.cloudflare?.bucket, 'sillytavern-manager-backup');

  // The bucket is reached through the Worker the connection deployed.
  const objects = await fetch(`${base}/api/v1/r2/objects`, { headers: { cookie: auth.cookie } });
  assert.equal(objects.status, 200);
  assert.deepEqual(await objects.json(), { objects: [] });
  assert.equal(state?.deployed, 'sillytavern-manager-backup');
  assert.equal((await (await fetch(`${base}/api/v1/r2/cloudflare`, { headers: { cookie: auth.cookie } })).json() as { cloudflare: { dataPath: string } }).cloudflare.dataPath, 'worker');

  const disconnected = await fetch(`${base}/api/v1/r2/cloudflare/disconnect`, { method: 'POST', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: base } });
  assert.equal(disconnected.status, 200);
  const result = await disconnected.json() as { revoked: boolean; workerKeyRemoved: boolean; config: ConfigBody['config'] };
  assert.deepEqual([result.revoked, result.workerKeyRemoved], [true, true]);
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.cloudflare?.state, 'disconnected');
});

test('a callback that does not match the sign-in, or that Cloudflare refused, lands on an error', async (t) => {
  const { manager, base } = await start();
  t.after(() => manager.close());
  const auth = await signIn(base);
  await beginConnect(base, auth);
  const forged = await callback(base, { state: 'not-the-one', code: 'good-code' }, auth.cookie);
  assert.equal(forged.headers.get('location'), '/?cloudflare=error&cloudflare_error=cloudflare_state_mismatch#data');
  const stateParam = await beginConnect(base, auth);
  const denied = await callback(base, { state: stateParam, error: 'access_denied' }, auth.cookie);
  assert.equal(denied.headers.get('location'), '/?cloudflare=error&cloudflare_error=cloudflare_authorization_denied#data');
  const config = await (await fetch(`${base}/api/v1/r2`, { headers: { cookie: auth.cookie } })).json() as ConfigBody;
  assert.equal(config.config.mode, 'keys');
});

test('with several accounts the panel is sent to choose, and choosing connects', async (t) => {
  const { manager, base } = await start({ cloudflare: { accounts: [{ id: ACCOUNT_ID, name: 'Personal' }, { id: OTHER_ACCOUNT_ID, name: 'Team' }] } });
  t.after(() => manager.close());
  const auth = await signIn(base);
  const landed = await callback(base, { state: await beginConnect(base, auth), code: 'good-code' }, auth.cookie);
  assert.equal(landed.headers.get('location'), '/?cloudflare=choose_account#data');
  const status = await (await fetch(`${base}/api/v1/r2/cloudflare`, { headers: { cookie: auth.cookie } })).json() as { cloudflare: { accounts: Array<{ name: string }> } };
  assert.deepEqual(status.cloudflare.accounts.map((account) => account.name), ['Personal', 'Team']);

  const invalid = await fetch(`${base}/api/v1/r2/cloudflare/account`, { method: 'POST', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: '../x' }) });
  assert.equal(invalid.status, 400);
  const chosen = await fetch(`${base}/api/v1/r2/cloudflare/account`, { method: 'POST', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: OTHER_ACCOUNT_ID }) });
  assert.equal(chosen.status, 200);
  const body = await chosen.json() as { cloudflare: { state: string; account: { name: string } }; config: ConfigBody['config'] };
  assert.equal(body.cloudflare.state, 'connected');
  assert.equal(body.cloudflare.account.name, 'Team');
  assert.equal(body.config.mode, 'cloudflare');
});

test('a manager without a Cloudflare client keeps to keys and says so', async (t) => {
  const { manager, base } = await start({ cloudflare: null });
  t.after(() => manager.close());
  const auth = await signIn(base);
  const config = await (await fetch(`${base}/api/v1/r2`, { headers: { cookie: auth.cookie } })).json() as ConfigBody;
  assert.equal(config.config.cloudflare, null);
  assert.equal((await fetch(`${base}/api/v1/r2/cloudflare`, { headers: { cookie: auth.cookie } })).status, 404);
  const refused = await fetch(`${base}/api/v1/r2`, { method: 'PUT', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'cloudflare' }) });
  assert.equal(refused.status, 400);
  assert.equal((await callback(base, { state: 'x', code: 'y' }, auth.cookie)).headers.get('location'), '/?cloudflare=error&cloudflare_error=cloudflare_not_available#data');
});
