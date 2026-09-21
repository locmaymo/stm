import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCOPES } from '../../../packages/cloudflare/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { CloudflareConnection } from '../../../packages/r2/src/index.js';
import { ACCOUNT_ID, fakeCloudflare, OTHER_ACCOUNT_ID, type FakeCloudflareState } from '../../../packages/r2/test/cloudflare-fake.js';
import type { SetupStatus } from '../../../packages/contracts/src/index.js';
import { CLOUDFLARE_CALLBACK_PATH, startManagerServer, type ManagerServer } from '../src/server.js';

/**
 * A manager nobody has set up, with a Cloudflare client configured.
 *
 * No `STM_ADMIN_PASSWORD`: the whole point of signing in with an account is
 * that there is no password, on a machine where setting one would be lost with
 * everything else by tomorrow.
 */
async function start(options: { cloudflare?: Partial<FakeCloudflareState>; password?: string; root?: string } = {}): Promise<{ manager: ManagerServer; base: string; state: FakeCloudflareState; root: string }> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'stm-cf-signin-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  const fake = await fakeCloudflare(options.cloudflare ?? {});
  const connection = new CloudflareConnection({
    paths,
    client: { clientId: 'client-1', redirectUri: 'http://localhost:7860/oauth/cloudflare/callback', scopes: Object.values(DEFAULT_SCOPES) },
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
  });
  const manager = await startManagerServer({
    host: '127.0.0.1', port: 0, paths, secureCookies: false, accessPort: 0, staticRoot,
    ...(options.password ? { env: { STM_ADMIN_PASSWORD: options.password } } : { env: {} }),
    logger: () => undefined, cloudflare: connection,
  });
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return { manager, base: `http://127.0.0.1:${address.port}`, state: fake.state, root };
}

async function begin(base: string): Promise<string> {
  const response = await fetch(`${base}/api/v1/auth/cloudflare`, { method: 'POST', headers: { origin: base } });
  assert.equal(response.status, 200, `starting the sign-in answered ${response.status}`);
  return new URL((await response.json() as { url: string }).url).searchParams.get('state') ?? '';
}

function callback(base: string, query: Record<string, string>): Promise<Response> {
  return fetch(`${base}${CLOUDFLARE_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`, { redirect: 'manual' });
}

function cookieFrom(response: Response): string | null {
  return /stm_session=[^;]+/u.exec(response.headers.get('set-cookie') ?? '')?.[0] ?? null;
}

test('a manager with no password is opened by the first Cloudflare account to ask', async (t) => {
  const { manager, base } = await start();
  t.after(() => manager.close());

  const before = await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus;
  assert.equal(before.setupRequired, true);
  assert.equal(before.cloudflareSignIn?.available, true);
  assert.equal(before.cloudflareSignIn?.owner, null);

  // Nothing is signed in yet, which is exactly the state this has to work in.
  assert.equal((await fetch(`${base}/api/v1/auth/session`)).status, 401);

  const landed = await callback(base, { state: await begin(base), code: 'good-code' });
  assert.equal(landed.status, 303);
  assert.equal(landed.headers.get('location'), '/?cloudflare=signed_in');
  const cookie = cookieFrom(landed);
  assert.ok(cookie, 'the callback opens a session, because having none is the point');

  // That session is a session like any other.
  assert.equal((await fetch(`${base}/api/v1/auth/session`, { headers: { cookie } })).status, 200);

  // And the manager is now set up, without a password ever being chosen.
  const after = await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus;
  assert.equal(after.setupRequired, false);
  assert.equal(after.cloudflareSignIn?.owner, 'Personal');

  // The account that opened it is also where its backups now go, because the
  // one sign-in is meant to be the whole of the setup.
  const config = await (await fetch(`${base}/api/v1/r2`, { headers: { cookie } })).json() as { config: { mode: string; enabled: boolean } };
  assert.equal(config.config.mode, 'cloudflare');
  assert.equal(config.config.enabled, true);
});

/*
 * The console is open in two places at once, which is the ordinary state of a
 * manager that has just been given a link for a phone: the machine it runs on,
 * and the link. There was one slot for a sign-in on its way to Cloudflare, so
 * the second press cancelled the first - and the tab that started first came
 * back to "started somewhere else" while the other one was let in, which reads
 * as the console refusing the address it is being read at.
 */
test('a sign-in started in one tab is not cancelled by one started in another', async (t) => {
  const { manager, base } = await start();
  t.after(() => manager.close());

  const first = await begin(base);
  const second = await begin(base);

  const firstLanded = await callback(base, { state: first, code: 'good-code' });
  assert.equal(firstLanded.headers.get('location'), '/?cloudflare=signed_in');
  assert.ok(cookieFrom(firstLanded), 'the tab that started first is let in');

  // The other one is still answerable, because it was never cancelled.
  const secondLanded = await callback(base, { state: second, code: 'good-code' });
  assert.equal(secondLanded.headers.get('location'), '/?cloudflare=signed_in');
  assert.ok(cookieFrom(secondLanded));

  // And a state stays good only once, however many are in flight.
  const again = await callback(base, { state: first, code: 'good-code' });
  assert.match(again.headers.get('location') ?? '', /cloudflare_error=cloudflare_state_mismatch/u);
});

test('a second account is refused, rather than handed a key', async (t) => {
  const { manager, base, state } = await start({ cloudflare: { accounts: [{ id: ACCOUNT_ID, name: 'Personal' }] } });
  t.after(() => manager.close());

  const first = await callback(base, { state: await begin(base), code: 'good-code' });
  assert.equal(first.headers.get('location'), '/?cloudflare=signed_in');

  // Somebody else's Cloudflare account, reaching a console that is open to the
  // internet. A manager with an owner is not a door the next arrival gets a
  // key to.
  state.accounts = [{ id: OTHER_ACCOUNT_ID, name: 'Somebody else' }];
  const intruder = await callback(base, { state: await begin(base), code: 'good-code' });
  assert.equal(intruder.status, 303);
  assert.match(intruder.headers.get('location') ?? '', /cloudflare_error=cloudflare_not_owner/u);
  assert.equal(cookieFrom(intruder), null, 'no session is opened for an account this manager does not belong to');

  // The owner is unchanged, and still the one named on the sign-in screen.
  assert.equal((await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus).cloudflareSignIn?.owner, 'Personal');

  // And the account that does own it is still let in.
  state.accounts = [{ id: ACCOUNT_ID, name: 'Personal' }];
  assert.ok(cookieFrom(await callback(base, { state: await begin(base), code: 'good-code' })));
});

test('signing in with an account does not become a way past the password', async (t) => {
  // A manager somebody set up by hand, then connected an account to. Their
  // password is still the password; the account is a second way in for the
  // same person, not a way round the first.
  const { manager, base } = await start({ password: 'correct horse battery staple' });
  t.after(() => manager.close());

  const status = await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus;
  assert.equal(status.setupRequired, false);

  const landed = await callback(base, { state: await begin(base), code: 'good-code' });
  assert.ok(cookieFrom(landed), 'the first account to sign in still claims an unclaimed manager');

  // And the password still works, because nothing replaced it.
  const password = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  assert.equal(password.status, 200);
});

test('a sign-in that Cloudflare refused says so, and opens nothing', async (t) => {
  const { manager, base } = await start();
  t.after(() => manager.close());

  const denied = await callback(base, { state: await begin(base), error: 'access_denied' });
  assert.equal(denied.status, 303);
  assert.match(denied.headers.get('location') ?? '', /cloudflare=error/u);
  assert.equal(cookieFrom(denied), null);

  // And the manager is still waiting to be set up rather than half set up.
  const status = await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus;
  assert.equal(status.setupRequired, true);
  assert.equal(status.cloudflareSignIn?.owner, null);
});

test('a link nobody started here cannot open a session', async (t) => {
  const { manager, base } = await start();
  t.after(() => manager.close());

  // No sign-in was begun, so there is no pending authorization and the state
  // belongs to nothing. It must not be treated as a connect either.
  const forged = await callback(base, { state: 'made-up', code: 'good-code' });
  assert.equal(forged.status, 303);
  assert.equal(cookieFrom(forged), null);
  assert.equal((await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus).setupRequired, true);
});

test('a console opened with an account can still be given a password of its own', async (t) => {
  /*
   * Somebody who signed in with Cloudflare and then wants a password too -
   * to reach the console from a machine that is not signed in, or simply
   * because they want one.
   *
   * This used to be refused with "finish setting the manager up first", on a
   * manager they were signed in to and using. The route only knew how to
   * change a password, and a console opened with an account has none to
   * change; the screen that sets a first one is the one they can no longer
   * reach, so there was no way out of it at all.
   */
  const { manager, base } = await start();
  t.after(() => manager.close());

  const landed = await callback(base, { state: await begin(base), code: 'good-code' });
  const cookie = cookieFrom(landed);
  assert.ok(cookie);
  const csrf = (await (await fetch(`${base}/api/v1/auth/session`, { headers: { cookie } })).json() as { session: { csrfToken: string } }).session.csrfToken;

  const set = await fetch(`${base}/api/v1/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, origin: base },
    body: JSON.stringify({ password: 'correct horse battery staple', confirmPassword: 'correct horse battery staple' }),
  });
  assert.equal(set.status, 200, await set.text());

  // And it is a real password: it opens the console on its own.
  const signedIn = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(signedIn.status, 200);

  // The account that owns the manager still owns it. Setting a password is
  // adding a second key, not handing the manager to whoever set it.
  assert.equal((await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus).cloudflareSignIn?.owner, 'Personal');
});
