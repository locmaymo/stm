import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCOPES } from '../../../packages/cloudflare/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { CloudflareConnection } from '../../../packages/r2/src/index.js';
import { fakeCloudflare } from '../../../packages/r2/test/cloudflare-fake.js';
import { RateLimiter } from '../src/rate-limit.js';
import { CLOUDFLARE_CALLBACK_PATH, startManagerServer, type ManagerServer } from '../src/server.js';

const PASSWORD = 'correct horse battery staple';

/** The fixed address the Worker in front of the tunnel answers on. */
const TUNNEL_HOST = 'stm.example.workers.dev';

/**
 * A manager with a small attempt budget, so a test can spend it in a moment.
 *
 * Three rather than the ten a real one has: the point being measured is whose
 * budget is spent, not how large it is.
 */
async function start(options: { password?: string; limit?: number; cloudflare?: boolean } = {}): Promise<{ manager: ManagerServer; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-rate-key-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  const connection = options.cloudflare
    ? new CloudflareConnection({
      paths,
      client: { clientId: 'client-1', redirectUri: 'http://localhost:7860/oauth/cloudflare/callback', scopes: Object.values(DEFAULT_SCOPES) },
      fetchImpl: (await fakeCloudflare({})).fetchImpl,
      sleep: async () => undefined,
    })
    : null;
  const manager = await startManagerServer({
    host: '127.0.0.1', port: 0, paths, secureCookies: false, accessPort: 0, staticRoot,
    env: options.password ? { STM_ADMIN_PASSWORD: options.password } : {},
    logger: () => undefined,
    rateLimiter: new RateLimiter({ limit: options.limit ?? 3 }),
    ...(connection ? { cloudflare: connection } : {}),
  });
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return { manager, base: `http://127.0.0.1:${address.port}` };
}

/**
 * The headers a request picks up on its way in from the internet.
 *
 * The Worker adds the two `x-forwarded-*` ones itself, and Cloudflare writes
 * `cf-connecting-ip` over anything the client sent. By the time this reaches
 * the manager the connection is `cloudflared`'s, from the loopback.
 */
function throughTunnel(visitor: string): Record<string, string> {
  return { 'x-forwarded-host': TUNNEL_HOST, 'x-forwarded-proto': 'https', 'cf-connecting-ip': visitor };
}

function login(base: string, password: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
  });
}

function setupPassword(base: string, password: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/v1/setup/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ password, termsAccepted: true, telemetryAccepted: true }),
  });
}

/*
 * The fault this is written against: everything arriving from the internet
 * reaches this process over the loopback, because `cloudflared` runs on the
 * machine and connects to it like any local program would. So one visitor
 * guessing passwords spent the budget of every other visitor - and of the
 * person sitting at the machine, who was then locked out of their own console
 * by somebody they have never met.
 */
test('one visitor guessing through the tunnel does not shut the door on anybody else', async (t) => {
  const { manager, base } = await start({ password: PASSWORD });
  t.after(() => manager.close());

  const guesser = throughTunnel('203.0.113.7');
  assert.equal((await login(base, 'wrong', guesser)).status, 401);
  assert.equal((await login(base, 'wrong', guesser)).status, 401);
  assert.equal((await login(base, 'wrong', guesser)).status, 401);
  const spent = await login(base, 'wrong', guesser);
  assert.equal(spent.status, 429, 'the visitor who did the guessing is cut off');
  assert.ok(spent.headers.get('retry-after'), 'and is told how long for');

  // The person at the machine, who has done nothing.
  assert.equal((await login(base, PASSWORD)).status, 200);

  // And somebody else on the internet, who has also done nothing.
  assert.equal((await login(base, 'wrong', throughTunnel('198.51.100.2'))).status, 401);
});

/*
 * The other half of the same rule. A forwarded address is only worth anything
 * because something trustworthy put it there; believed unconditionally it
 * would be the opposite of a limiter, since a guesser would simply write a new
 * one on every attempt.
 */
test('a forwarded address counts only when something in front of the manager sent it', async (t) => {
  const { manager, base } = await start({ password: PASSWORD });
  t.after(() => manager.close());

  // Reaching the manager directly and claiming to be a different visitor each
  // time. Nothing is in front of this request - it was addressed to the machine
  // itself - so the header is not the manager's to believe.
  assert.equal((await login(base, 'wrong', { 'cf-connecting-ip': '203.0.113.1' })).status, 401);
  assert.equal((await login(base, 'wrong', { 'x-forwarded-for': '203.0.113.2' })).status, 401);
  assert.equal((await login(base, 'wrong', { 'cf-connecting-ip': '203.0.113.3' })).status, 401);
  assert.equal((await login(base, 'wrong', { 'cf-connecting-ip': '203.0.113.4' })).status, 429);
});

/*
 * `X-Forwarded-For` is a chain, and each hop appends to it. Cloudflare appends
 * rather than replaces, so whatever a client wrote is still in front of the
 * entry the edge added - and the last one is the only one worth reading.
 */
test('the last entry of a forwarded chain is the one believed', async (t) => {
  const { manager, base } = await start({ password: PASSWORD });
  t.after(() => manager.close());

  const spoofed = (claimed: string): Record<string, string> => ({
    'x-forwarded-host': TUNNEL_HOST,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': `${claimed}, 203.0.113.7`,
  });
  assert.equal((await login(base, 'wrong', spoofed('10.0.0.1'))).status, 401);
  assert.equal((await login(base, 'wrong', spoofed('10.0.0.2'))).status, 401);
  assert.equal((await login(base, 'wrong', spoofed('10.0.0.3'))).status, 401);
  assert.equal((await login(base, 'wrong', spoofed('10.0.0.4'))).status, 429, 'a new name in front of the chain buys nothing');

  // And the visitor the chain actually ends at is the one shut out, not
  // everybody who arrives through the tunnel.
  assert.equal((await login(base, 'wrong', throughTunnel('198.51.100.9'))).status, 401);
});

/*
 * The limiter is there to make guessing expensive. A sign-in that worked is
 * not a guess, and counting it meant ordinary use ate the budget: a console
 * opened and closed a few times in an afternoon locked out its own owner.
 */
test('a password that works gives the attempt back', async (t) => {
  const { manager, base } = await start({ password: PASSWORD });
  t.after(() => manager.close());

  assert.equal((await login(base, 'wrong')).status, 401);
  assert.equal((await login(base, 'wrong')).status, 401);
  assert.equal((await login(base, PASSWORD)).status, 200);

  // The budget is whole again, and still strict once it runs out.
  assert.deepEqual(
    [(await login(base, 'wrong')).status, (await login(base, 'wrong')).status, (await login(base, 'wrong')).status],
    [401, 401, 401],
  );
  assert.equal((await login(base, 'wrong')).status, 429);
});

test('setting the first password gives the attempt back', async (t) => {
  const { manager, base } = await start();
  t.after(() => manager.close());

  // Two attempts spent on a password the policy refuses.
  assert.equal((await setupPassword(base, 'short')).status, 400);
  assert.equal((await setupPassword(base, 'short')).status, 400);
  assert.equal((await setupPassword(base, PASSWORD)).status, 201);

  assert.equal((await login(base, 'wrong')).status, 401);
  assert.equal((await login(base, 'wrong')).status, 401);
  assert.equal((await login(base, 'wrong')).status, 401);
  assert.equal((await login(base, 'wrong')).status, 429);
});

test('signing in with a Cloudflare account gives the attempt back', async (t) => {
  const { manager, base } = await start({ cloudflare: true });
  t.after(() => manager.close());

  assert.equal((await setupPassword(base, 'short')).status, 400);
  assert.equal((await setupPassword(base, 'short')).status, 400);

  // The third and last attempt in the budget starts the sign-in.
  const begun = await fetch(`${base}/api/v1/auth/cloudflare`, { method: 'POST', headers: { origin: base } });
  assert.equal(begun.status, 200);
  const state = new URL((await begun.json() as { url: string }).url).searchParams.get('state') ?? '';
  const landed = await fetch(`${base}${CLOUDFLARE_CALLBACK_PATH}?${new URLSearchParams({ state, code: 'good-code' }).toString()}`, { redirect: 'manual' });
  assert.equal(landed.headers.get('location'), '/?cloudflare=signed_in');

  // Which leaves the console reachable rather than rate limited by its own
  // sign-in: on a machine with no password this is the only way in.
  const again = await fetch(`${base}/api/v1/auth/cloudflare`, { method: 'POST', headers: { origin: base } });
  assert.equal(again.status, 200, 'the successful sign-in cleared what had been spent');
});
