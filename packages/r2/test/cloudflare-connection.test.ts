import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeState, DEFAULT_SCOPES } from '../../cloudflare/src/index.js';
import { getPlatformPaths } from '../../platform/src/index.js';
import { CloudflareConnection } from '../src/cloudflare-connection.js';
import { R2Error, type Billing } from '../src/store.js';
import { ACCOUNT_ID, fakeCloudflare, OTHER_ACCOUNT_ID, type FakeCloudflareState } from './cloudflare-fake.js';

const CLIENT = { clientId: 'client-1', redirectUri: 'https://stm.example.com/oauth/cloudflare/callback', scopes: Object.values(DEFAULT_SCOPES) };

async function setup(overrides: Partial<FakeCloudflareState> = {}, options: { root?: string; clock?: { now: number } } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'stm-cf-connection-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const cloudflare = await fakeCloudflare(overrides);
  const clock = options.clock ?? { now: Date.now() };
  const make = () => new CloudflareConnection({ paths, client: CLIENT, fetchImpl: cloudflare.fetchImpl, now: () => clock.now, sleep: async () => undefined });
  return { root, paths, cloudflare, clock, connection: make(), make };
}

async function connect(connection: CloudflareConnection): Promise<Awaited<ReturnType<CloudflareConnection['completeConnect']>>> {
  const url = new URL(connection.beginConnect('https://tunnel.example.com/panel'));
  return await connection.completeConnect({ state: url.searchParams.get('state') ?? '', code: 'good-code' });
}

test('connecting with one account sets up the bucket and keeps only the refresh token on disk', async () => {
  const { connection, cloudflare, paths } = await setup();
  const url = new URL(connection.beginConnect('https://tunnel.example.com/panel'));
  assert.equal(decodeState(url.searchParams.get('state') ?? '')?.returnOrigin, 'https://tunnel.example.com');
  const status = await connection.completeConnect({ state: url.searchParams.get('state') ?? '', code: 'good-code' });
  assert.equal(status.state, 'connected');
  assert.deepEqual(status.account, { id: ACCOUNT_ID, name: 'Personal' });
  assert.equal(status.bucket, 'sillytavern-manager-backup');
  assert.equal(status.analyticsGranted, true);
  assert.ok(cloudflare.state.buckets.has('sillytavern-manager-backup'));

  const file = join(paths.state, 'cloudflare-connection.json');
  const saved = await readFile(file, 'utf8');
  assert.match(saved, /"refreshToken": "refresh-1"/u);
  assert.doesNotMatch(saved, /access-1/u);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('a callback for a sign-in this manager did not start, or a denied one, is refused', async () => {
  const { connection } = await setup();
  connection.beginConnect('http://localhost:7860');
  await assert.rejects(connection.completeConnect({ state: 'forged', code: 'good-code' }), (error: unknown) => error instanceof R2Error && error.code === 'cloudflare_state_mismatch');
  const url = new URL(connection.beginConnect('http://localhost:7860'));
  await assert.rejects(connection.completeConnect({ state: url.searchParams.get('state') ?? '', error: 'access_denied' }), (error: unknown) => error instanceof R2Error && error.code === 'cloudflare_authorization_denied');
  // A state is good once.
  await assert.rejects(connection.completeConnect({ state: url.searchParams.get('state') ?? '', code: 'good-code' }), (error: unknown) => error instanceof R2Error && error.code === 'cloudflare_state_mismatch');
  assert.equal((await connection.status()).state, 'disconnected');
});

test('with several accounts the user chooses, and only an offered account can be chosen', async () => {
  const { connection, cloudflare } = await setup({ accounts: [{ id: ACCOUNT_ID, name: 'Personal' }, { id: OTHER_ACCOUNT_ID, name: 'Team' }] });
  const status = await connect(connection);
  assert.equal(status.state, 'choose_account');
  assert.deepEqual(status.accounts.map((account) => account.name), ['Personal', 'Team']);
  assert.equal(cloudflare.state.buckets.size, 0);
  await assert.rejects(connection.chooseAccount('00000000000000000000000000000000'), (error: unknown) => error instanceof R2Error && error.code === 'cloudflare_unknown_account');
  assert.equal((await connection.chooseAccount(OTHER_ACCOUNT_ID)).account?.name, 'Team');
});

test('backups go through the Worker, which is deployed and keyed on first use', async () => {
  const { connection, cloudflare } = await setup();
  await connect(connection);
  const billed: Billing[] = [];
  const store = connection.objectStore((billing) => billed.push(billing));
  await store.putObject('sillytavern-manager/blobs/a', new Uint8Array([1, 2]), 'application/octet-stream');
  assert.deepEqual([...(await store.getObject('sillytavern-manager/blobs/a'))], [1, 2]);
  assert.equal((await store.listObjects('sillytavern-manager/', 10)).objects.length, 1);
  assert.equal(cloudflare.state.deployed, true);
  assert.ok(cloudflare.state.calls.some((call) => call.startsWith('worker PUT /v1/o/')));
  assert.ok(!cloudflare.state.calls.some((call) => call.includes('/objects/')), 'no object went over the REST API');
  assert.deepEqual(billed, ['charged', 'read', 'charged']);
  const status = await connection.status();
  assert.equal(status.dataPath, 'worker');
  assert.equal(status.restReason, null);
});

test('without the Workers scope, backups go over REST and say why', async () => {
  const { connection, cloudflare } = await setup({ grantedScopes: ['workers-r2.read', 'workers-r2.write', 'workers-r2-bucket-item.read', 'workers-r2-bucket-item.write', 'offline_access'] });
  await connect(connection);
  const store = connection.objectStore(() => undefined);
  await store.putObject('sillytavern-manager/blobs/a', new Uint8Array([3]), 'application/octet-stream');
  assert.deepEqual([...(await store.getObject('sillytavern-manager/blobs/a'))], [3]);
  assert.equal(cloudflare.state.deployed, false);
  const status = await connection.status();
  assert.equal(status.dataPath, 'rest');
  assert.equal(status.restReason, 'workers_not_granted');
  assert.equal(status.analyticsGranted, false);
});

/**
 * Moves time for the manager and the Worker together.
 *
 * The Worker running in these tests reads the real clock to check a request's
 * timestamp, so a clock only the manager could see would look like skew to it.
 */
function sharedClock(context: { mock: { timers: { enable(options: { apis: ['Date']; now: number }): void; setTime(milliseconds: number): void } } }): { readonly now: number; advance(milliseconds: number): void } {
  let current = Date.now();
  context.mock.timers.enable({ apis: ['Date'], now: current });
  return {
    get now() { return current; },
    advance(milliseconds: number) { current += milliseconds; context.mock.timers.setTime(current); },
  };
}

test('when workers.dev cannot be reached, data goes over REST until the Worker is tried again an hour later', async (context) => {
  const time = sharedClock(context);
  const { connection, cloudflare } = await setup({ workersDevBlocked: true }, { clock: time });
  await connect(connection);
  const store = connection.objectStore(() => undefined);
  await store.putObject('sillytavern-manager/blobs/a', new Uint8Array([4]), 'application/octet-stream');
  let status = await connection.status();
  assert.equal(status.dataPath, 'rest');
  assert.equal(status.restReason, 'worker_unavailable');
  assert.match(status.lastError ?? '', /slower REST API/u);

  cloudflare.state.workersDevBlocked = false;
  await store.getObject('sillytavern-manager/blobs/a');
  assert.equal((await connection.status()).dataPath, 'rest');
  time.advance(60 * 60 * 1000 + 1);
  await store.getObject('sillytavern-manager/blobs/a');
  status = await connection.status();
  assert.equal(status.dataPath, 'worker');
});

test('an expired access token is refreshed once for requests side by side, and the rotated token is saved first', async () => {
  const { connection, cloudflare, clock, paths } = await setup({ expiresIn: 120 });
  await connect(connection);
  const store = connection.objectStore(() => undefined);
  clock.now += 120_000;
  cloudflare.state.calls.length = 0;
  await Promise.all([1, 2, 3].map(async (index) => await store.putObject(`sillytavern-manager/blobs/${index}`, new Uint8Array([index]), 'application/octet-stream')));
  assert.equal(cloudflare.state.calls.filter((call) => call === 'oauth refresh_token').length, 1);
  assert.match(await readFile(join(paths.state, 'cloudflare-connection.json'), 'utf8'), new RegExp(`"refreshToken": "${cloudflare.state.refreshToken ?? ''}"`, 'u'));
});

test('a restarted manager carries on from the saved grant with a fresh Worker key', async () => {
  const first = await setup();
  await connect(first.connection);
  await first.connection.objectStore(() => undefined).putObject('sillytavern-manager/blobs/a', new Uint8Array([5]), 'application/octet-stream');
  const keyBefore = first.cloudflare.state.secrets.get([...first.cloudflare.state.secrets.keys()][0] ?? '');

  const restarted = first.make();
  assert.equal((await restarted.status()).state, 'connected');
  assert.deepEqual([...(await restarted.objectStore(() => undefined).getObject('sillytavern-manager/blobs/a'))], [5]);
  assert.equal(first.cloudflare.state.secrets.size, 1, 'the same installation keeps one key');
  assert.notEqual(first.cloudflare.state.secrets.values().next().value, keyBefore);
});

test('the Worker key is rotated after a day', async (context) => {
  const time = sharedClock(context);
  const { connection, cloudflare } = await setup({}, { clock: time });
  await connect(connection);
  const store = connection.objectStore(() => undefined);
  await store.putObject('sillytavern-manager/blobs/a', new Uint8Array([6]), 'application/octet-stream');
  const before = [...cloudflare.state.secrets.values()][0];
  time.advance(24 * 60 * 60 * 1000 + 1);
  await store.getObject('sillytavern-manager/blobs/a');
  assert.notEqual([...cloudflare.state.secrets.values()][0], before);
});

test('a revoked grant asks for a reconnect instead of failing every backup', async () => {
  const { connection, cloudflare, clock } = await setup({ expiresIn: 120 });
  await connect(connection);
  cloudflare.state.refreshToken = 'revoked-in-dashboard';
  clock.now += 120_000;
  await assert.rejects(connection.objectStore(() => undefined).putObject('sillytavern-manager/x', new Uint8Array([1]), 'application/octet-stream'), (error: unknown) => error instanceof R2Error && error.code === 'cloudflare_reconnect_required');
  const status = await connection.status();
  assert.equal(status.state, 'reconnect_required');
  assert.deepEqual(status.account, { id: ACCOUNT_ID, name: 'Personal' });
  // Reconnecting to the same account keeps its bucket without asking.
  assert.equal((await connect(connection)).state, 'connected');
});

test('disconnecting removes this installation\'s Worker key, revokes the grant and forgets it', async () => {
  const { connection, cloudflare, paths } = await setup();
  await connect(connection);
  await connection.objectStore(() => undefined).putObject('sillytavern-manager/blobs/a', new Uint8Array([7]), 'application/octet-stream');
  assert.equal(cloudflare.state.secrets.size, 1);
  const refresh = cloudflare.state.refreshToken;
  assert.deepEqual(await connection.disconnect(), { revoked: true, workerKeyRemoved: true });
  assert.equal(cloudflare.state.secrets.size, 0);
  assert.deepEqual(cloudflare.state.revoked, [refresh]);
  assert.equal((await connection.status()).state, 'disconnected');
  assert.doesNotMatch(await readFile(join(paths.state, 'cloudflare-connection.json'), 'utf8'), /refresh-/u);
  await assert.rejects(connection.objectStore(() => undefined).getObject('sillytavern-manager/blobs/a'), (error: unknown) => error instanceof R2Error && error.code === 'r2_not_configured');
});
