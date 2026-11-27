import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { GoogleConnection, R2Error } from '../../../packages/r2/src/index.js';
import { fakeGoogle, type FakeGoogle } from '../../../packages/r2/test/google-fake.js';
import type { SetupStatus } from '../../../packages/contracts/src/index.js';
import { GOOGLE_CALLBACK_PATH, startManagerServer, type ManagerServer } from '../src/server.js';

const CLIENT = { clientId: 'client-id.apps.example', redirectUri: 'https://relay.example/oauth/google/callback', brokerUrl: 'https://broker.example' };
const PASSWORD = 'correct horse battery staple';

/**
 * A connection that lets the sign-in name and claim its account, and then
 * fails - which is the shape of every lock-out readers met: a claim written,
 * and no session for anybody.
 */
class FailsAfterTheClaim extends GoogleConnection {
  public override async completeConnect(_callback: { state: string; code?: string | null; error?: string | null }, options: { readonly accept?: (account: { id: string; email: string; name: string | null }) => Promise<boolean | string> } = {}): Promise<never> {
    await options.accept?.({ id: 'perm-owner@example.com', email: 'owner@example.com', name: null });
    throw new R2Error('google_drive_failed', 'Google Drive answered 500');
  }
}

async function start(options: { password?: string; failing?: boolean } = {}): Promise<{ manager: ManagerServer; base: string; fake: FakeGoogle }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-google-signin-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  const fake = fakeGoogle({ email: 'owner@example.com' });
  const google = new (options.failing ? FailsAfterTheClaim : GoogleConnection)({ paths, client: CLIENT, fetchImpl: fake.fetchImpl, sleep: async () => undefined });
  const manager = await startManagerServer({
    host: '127.0.0.1', port: 0, paths, secureCookies: false, accessPort: 0, staticRoot,
    env: options.password ? { STM_ADMIN_PASSWORD: options.password } : {},
    logger: () => undefined, cloudflare: null, google,
  });
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return { manager, base: `http://127.0.0.1:${address.port}`, fake };
}

/** Start a sign-in and walk Google's page as `email`; the callback's answer. */
async function signIn(base: string, fake: FakeGoogle, email = 'owner@example.com'): Promise<Response> {
  const started = await fetch(`${base}/api/v1/auth/google`, { method: 'POST', headers: { origin: base } });
  assert.equal(started.status, 200, `starting the sign-in answered ${started.status}`);
  const url = new URL((await started.json() as { url: string }).url);
  const code = fake.issueCode(url.searchParams.get('code_challenge') ?? '', email);
  return await fetch(`${base}${GOOGLE_CALLBACK_PATH}?${new URLSearchParams({ state: url.searchParams.get('state') ?? '', code }).toString()}`, { redirect: 'manual' });
}

function cookieFrom(response: Response): string | null {
  return /stm_session=[^;]+/u.exec(response.headers.get('set-cookie') ?? '')?.[0] ?? null;
}

async function setupStatus(base: string): Promise<SetupStatus> {
  return await (await fetch(`${base}/api/v1/setup/status`)).json() as SetupStatus;
}

test('a manager nobody set up is opened by the first Google account, which may come back', async (t) => {
  const { manager, base, fake } = await start();
  t.after(() => manager.close());

  const landed = await signIn(base, fake);
  assert.equal(landed.headers.get('location'), '/?google=signed_in');
  const cookie = cookieFrom(landed);
  assert.ok(cookie);
  const session = await (await fetch(`${base}/api/v1/auth/session`, { headers: { cookie } })).json() as { managerPassword: boolean };
  // Opened without a password, which the console now asks for straight away.
  assert.equal(session.managerPassword, false);
  assert.equal((await setupStatus(base)).googleSignIn?.owner, 'owner@example.com');

  assert.ok(cookieFrom(await signIn(base, fake)), 'the owner signs in again');
  const stranger = await signIn(base, fake, 'stranger@example.com');
  assert.match(stranger.headers.get('location') ?? '', /google_error=google_not_owner/u);
  assert.equal(cookieFrom(stranger), null);
});

test('a Google sign-in that fails after claiming the manager leaves it blank', async (t) => {
  const { manager, base, fake } = await start({ failing: true });
  t.after(() => manager.close());

  const landed = await signIn(base, fake);
  assert.match(landed.headers.get('location') ?? '', /google=error/u);
  assert.equal(cookieFrom(landed), null);
  const status = await setupStatus(base);
  assert.equal(status.setupRequired, true, 'nobody got in, so nobody owns it');
  assert.equal(status.googleSignIn?.owner, null);

  // The first-run password is still taken.
  const setup = await fetch(`${base}/api/v1/setup/password`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password: PASSWORD, termsAccepted: true, telemetryAccepted: true }),
  });
  assert.equal(setup.status, 201, await setup.text());
});

test('a Google sign-in on a manager with a password says to use the password first', async (t) => {
  const { manager, base, fake } = await start({ password: PASSWORD });
  t.after(() => manager.close());

  const landed = await signIn(base, fake);
  assert.match(landed.headers.get('location') ?? '', /google_error=google_password_first/u);
  assert.equal(cookieFrom(landed), null);
  // And the grant it was refused with is handed back to Google.
  assert.equal(fake.calls.revoke, 1);
});
