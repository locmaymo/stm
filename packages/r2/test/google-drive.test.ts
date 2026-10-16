import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { GoogleConnection, R2Manager, type SyncSource } from '../src/index.js';
import { hashFile } from '../src/sync.js';
import { fakeGoogle, type FakeGoogle } from './google-fake.js';

const CLIENT = { clientId: 'client-id.apps.example', redirectUri: 'https://relay.example/oauth/google/callback', brokerUrl: 'https://broker.example' };

function profile(): Profile {
  return {
    id: 'profile-1', name: 'Default', installationId: 'install-1', runtimePath: '/runtime', configPath: '/runtime/config.yaml',
    dataPath: '/runtime/data', layout: 'data', active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null,
  };
}

interface Machine { root: string; google: GoogleConnection; manager: R2Manager; sleeps: number[] }

async function machine(fake: FakeGoogle, label: string, now?: () => number): Promise<Machine> {
  const root = await mkdtemp(join(tmpdir(), 'stm-gdrive-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const sleeps: number[] = [];
  const google = new GoogleConnection({ paths, client: CLIENT, fetchImpl: fake.fetchImpl, sleep: async (milliseconds) => { sleeps.push(milliseconds); }, ...(now ? { now } : {}) });
  const manager = new R2Manager({ paths, env: { STM_DATA_DIR: root }, logger: () => undefined, google, installationLabel: label, ...(now ? { now: () => new Date(now()) } : {}) });
  return { root, google, manager, sleeps };
}

/** Walk the browser part of a sign-in: the consent screen answers with a code for this challenge. */
async function signIn(fake: FakeGoogle, google: GoogleConnection): Promise<void> {
  const url = new URL(google.beginConnect('http://127.0.0.1:7860'));
  const state = url.searchParams.get('state') ?? '';
  const code = fake.issueCode(url.searchParams.get('code_challenge') ?? '');
  await google.completeConnect({ state, code });
}

async function source(root: string, name: string, body: string): Promise<SyncSource> {
  const path = join(root, name.replaceAll('/', '-'));
  await writeFile(path, body);
  const file = await hashFile(name, path);
  assert.ok(file);
  return { file, path };
}

test('the sign-in asks Google for the app folder only, a lasting grant, and PKCE', async () => {
  const fake = fakeGoogle();
  const { google } = await machine(fake, 'desk');
  const url = new URL(google.beginConnect('http://127.0.0.1:7860/some/page'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), CLIENT.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CLIENT.redirectUri);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // The relay page reads where to send the browser back from the state.
  const state = JSON.parse(Buffer.from(url.searchParams.get('state') ?? '', 'base64url').toString('utf8')) as { o: string };
  assert.equal(state.o, 'http://127.0.0.1:7860');
});

test('connecting keeps the grant on disk and finds the account, without making anything in the Drive', async () => {
  const fake = fakeGoogle({ email: 'reader@example.com' });
  const desk = await machine(fake, 'desk');
  await signIn(fake, desk.google);
  const status = await desk.google.status();
  assert.equal(status.state, 'connected');
  assert.equal(status.email, 'reader@example.com');
  assert.equal(fake.files.size, 0);

  // The refresh token is the one secret, and it lives in the state directory only.
  const stored = JSON.parse(await readFile(join(desk.root, 'state', 'google-connection.json'), 'utf8')) as { refreshToken: string; scope: string };
  assert.match(stored.refreshToken, /^1-test-/u);
  assert.equal(stored.scope, 'https://www.googleapis.com/auth/drive.appdata');
});

test('a grant without Drive access ticked is refused and given back', async () => {
  const fake = fakeGoogle({ scope: 'openid' });
  const desk = await machine(fake, 'desk');
  await assert.rejects(signIn(fake, desk.google), { code: 'google_scope_missing' });
  assert.equal(fake.calls.revoke, 1);
  assert.equal((await desk.google.status()).state, 'disconnected');
});

test('a manager connected before backups moved to the app folder is asked to connect again', async () => {
  const fake = fakeGoogle();
  const root = await mkdtemp(join(tmpdir(), 'stm-gdrive-'));
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(root, 'state', 'google-connection.json'), JSON.stringify({
    schemaVersion: 1, installationKeyId: 'abcdef0123456789', refreshToken: '1-old-token', account: { id: 'perm-1', email: 'reader@example.com', name: null },
    folders: { root: 'folder-root', data: 'folder-data' }, connectedAt: '2026-10-16T00:00:00.000Z', reconnectRequired: false, lastError: null, displacedBy: null,
  }));
  const google = new GoogleConnection({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } }), client: CLIENT, fetchImpl: fake.fetchImpl });
  const status = await google.status();
  assert.equal(status.state, 'reconnect_required');
  assert.match(status.lastError ?? '', /hidden folder/u);
  assert.equal(await google.target(), null);
});

test('a sign-in this manager did not start, or one refused on the consent screen, connects nothing', async () => {
  const fake = fakeGoogle();
  const { google } = await machine(fake, 'desk');
  await assert.rejects(google.completeConnect({ state: 'not-ours', code: 'x' }), { code: 'google_state_mismatch' });
  const url = new URL(google.beginConnect('http://127.0.0.1:7860'));
  await assert.rejects(google.completeConnect({ state: url.searchParams.get('state') ?? '', error: 'access_denied' }), { code: 'google_authorization_denied' });
  // A state is good once, refused or not.
  await assert.rejects(google.completeConnect({ state: url.searchParams.get('state') ?? '', code: 'x' }), { code: 'google_state_mismatch' });
  assert.equal((await google.status()).state, 'disconnected');
});

test('a backup to Drive sends only what changed and reads back whole', async () => {
  const fake = fakeGoogle();
  const desk = await machine(fake, 'desk');
  await signIn(fake, desk.google);
  await desk.manager.update({ mode: 'google', enabled: true });
  const config = await desk.manager.getConfig();
  assert.equal(config.mode, 'google');
  assert.equal(config.configured, true);
  assert.equal(config.google?.state, 'connected');

  const settings = await source(desk.root, 'settings.json', '{"a":1}');
  const chat = await source(desk.root, 'chats/one.jsonl', 'first line\n');
  // The console can see a backup moving, whoever started it, and that it ended.
  const seen: Array<{ completedItems: number; totalItems: number } | null> = [];
  const first = await desk.manager.syncProfile({ profile: profile(), sources: [settings, chat], fingerprint: 'one', onProgress: () => { void desk.manager.getConfig().then((config) => { seen.push(config.transfer); }); } });
  assert.equal(first.uploadedChunks, 2);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(seen.some((transfer) => transfer?.totalItems === 2 && transfer.completedItems > 0));
  assert.equal((await desk.manager.getConfig()).transfer, null);

  // Everything is in the app folder; the two small chunks travel as one pack.
  const byName = new Map([...fake.files.values()].map((file) => [file.name, file]));
  assert.ok([...fake.files.values()].every((file) => file.parents.includes('appDataFolder')));
  assert.equal([...fake.files.values()].filter((file) => file.name.includes('/blobs/')).length, 0);
  assert.equal([...fake.files.values()].filter((file) => file.name.startsWith('stm-packs/')).length, 1);
  assert.ok(byName.get('sillytavern-manager/owner.json'), 'the claim is written');

  const grown = await source(desk.root, 'chats/one.jsonl', 'first line\nsecond line\n');
  const second = await desk.manager.syncProfile({ profile: profile(), sources: [settings, grown], fingerprint: 'two' });
  assert.equal(second.uploadedChunks, 1);
  assert.equal(second.reusedChunks, 1);

  const snapshots = await desk.manager.listSnapshots('profile-1');
  assert.equal(snapshots.length, 2);
  const latest = await desk.manager.readSnapshot('profile-1', snapshots[0]!.id);
  assert.equal(latest.fingerprint, 'two');
  const chunk = latest.files.find((file) => file.name === 'chats/one.jsonl')!.chunks[0]!;
  assert.equal((await desk.manager.readBlob(chunk.hash)).toString(), 'first line\nsecond line\n');

  // A machine that has never seen this Drive finds packed chunks from the packs alone.
  const laptop = await machine(fake, 'laptop');
  await signIn(fake, laptop.google);
  await laptop.manager.update({ mode: 'google', enabled: true });
  const settingsChunk = settings.file.chunks[0]!;
  assert.equal((await laptop.manager.readBlob(settingsChunk.hash)).toString(), '{"a":1}');
});

test('retention and the sweep remove what nothing names from Drive too', async () => {
  const fake = fakeGoogle();
  let clock = Date.parse('2026-10-16T00:00:00.000Z');
  const desk = await machine(fake, 'desk', () => clock);
  await signIn(fake, desk.google);
  await desk.manager.update({ mode: 'google', enabled: true, keepRecent: 1, keepDaily: 0, keepWeekly: 0 });
  const first = await source(desk.root, 'chats/one.jsonl', 'version one\n');
  await desk.manager.syncProfile({ profile: profile(), sources: [first], fingerprint: 'one' });
  clock += 60_000;
  const second = await source(desk.root, 'chats/one.jsonl', 'version two\n');
  await desk.manager.syncProfile({ profile: profile(), sources: [second], fingerprint: 'two' });
  assert.equal((await desk.manager.pruneSnapshots('profile-1')).length, 1);
  const swept = await desk.manager.reconcile();
  assert.equal(swept.collectedBlobs, 1);
  const orphan = first.file.chunks[0]!.hash;
  assert.ok(![...fake.files.values()].some((file) => file.name.endsWith(orphan)));
  assert.equal((await desk.manager.readBlob(second.file.chunks[0]!.hash)).toString(), 'version two\n');
});

test('Drive saying "slow down" is waited out, and an ended access token is refreshed', async () => {
  const fake = fakeGoogle();
  const desk = await machine(fake, 'desk');
  await signIn(fake, desk.google);
  await desk.manager.update({ mode: 'google', enabled: true });
  fake.failNext(429, 2);
  fake.failNext(403, 1, 'userRateLimitExceeded');
  const chat = await source(desk.root, 'chats/one.jsonl', 'hello\n');
  await desk.manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'one' });
  assert.equal(desk.sleeps.length, 3);
  assert.ok(desk.sleeps.every((wait) => wait >= 1000));

  const refreshes = fake.calls.refresh;
  fake.expireAccessTokens();
  const again = await source(desk.root, 'chats/two.jsonl', 'again\n');
  await desk.manager.syncProfile({ profile: profile(), sources: [chat, again], fingerprint: 'two' });
  assert.equal(fake.calls.refresh, refreshes + 1);
});

test('a grant revoked at Google turns into "reconnect", not a loop of failures', async () => {
  const fake = fakeGoogle();
  const desk = await machine(fake, 'desk');
  await signIn(fake, desk.google);
  await desk.manager.update({ mode: 'google', enabled: true });
  fake.revokeAll();
  const chat = await source(desk.root, 'chats/one.jsonl', 'hello\n');
  await assert.rejects(desk.manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'one' }), { code: 'google_reconnect_required' });
  assert.equal((await desk.google.status()).state, 'reconnect_required');
  assert.equal((await desk.manager.getConfig()).configured, false);
});

test('signing in on a second machine takes the Drive over, and the first one stands down', async () => {
  const fake = fakeGoogle();
  let clock = Date.parse('2026-10-16T00:00:00.000Z');
  const desk = await machine(fake, 'desk', () => clock);
  await signIn(fake, desk.google);
  await desk.manager.update({ mode: 'google', enabled: true });
  const chat = await source(desk.root, 'chats/one.jsonl', 'hello\n');
  await desk.manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'one' });

  clock += 60_000;
  const laptop = await machine(fake, 'laptop', () => clock);
  await signIn(fake, laptop.google);
  await laptop.manager.update({ mode: 'google', enabled: true });
  await laptop.manager.takeOwnership();

  clock += 60_000;
  await desk.manager.refreshClaim();
  const status = await desk.google.status();
  assert.equal(status.state, 'reconnect_required');
  assert.equal(status.displacedBy, 'laptop');
});

test('a machine that leaves the grant in place does not sign out the one backing up', async () => {
  const fake = fakeGoogle();
  const desk = await machine(fake, 'desk');
  const laptop = await machine(fake, 'laptop');
  await signIn(fake, desk.google);
  await signIn(fake, laptop.google);
  assert.deepEqual(await desk.google.disconnect({ revoke: false }), { revoked: false });
  assert.equal(fake.calls.revoke, 0);
  // The laptop's own sign-in still works: its token refreshes.
  fake.expireAccessTokens();
  await laptop.manager.update({ mode: 'google', enabled: true });
  const chat = await source(laptop.root, 'chats/one.jsonl', 'hello\n');
  await laptop.manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'one' });
  assert.equal((await laptop.google.status()).state, 'connected');
});

test('a refused sign-in keeps the owner’s Drive connected and revokes the stranger’s grant', async () => {
  const fake = fakeGoogle({ email: 'owner@example.com' });
  const desk = await machine(fake, 'desk');
  await signIn(fake, desk.google);
  const before = await desk.google.status();

  const url = new URL(desk.google.beginConnect('http://127.0.0.1:7860', undefined, 'signIn'));
  assert.equal(desk.google.pendingPurpose(url.searchParams.get('state') ?? ''), 'signIn');
  const code = fake.issueCode(url.searchParams.get('code_challenge') ?? '', 'stranger@example.com');
  const seen: string[] = [];
  await assert.rejects(desk.google.completeConnect({ state: url.searchParams.get('state') ?? '', code }, {
    accept: async (account) => { seen.push(`${account.id} ${account.email}`); return false; },
  }), { code: 'google_not_owner' });
  assert.deepEqual(seen, ['perm-stranger@example.com stranger@example.com']);
  assert.equal(fake.calls.revoke, 1);

  // Still the owner's, and still working.
  const after = await desk.google.status();
  assert.equal(after.email, 'owner@example.com');
  assert.equal(after.state, 'connected');
  assert.equal(after.connectedAt, before.connectedAt);
  assert.equal((await desk.google.account())?.id, 'perm-owner@example.com');
  fake.expireAccessTokens();
  await desk.manager.update({ mode: 'google', enabled: true });
  const chat = await source(desk.root, 'chats/one.jsonl', 'hello\n');
  await desk.manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'one' });
});

test('disconnecting revokes the grant at Google and leaves the files in Drive', async () => {
  const fake = fakeGoogle();
  const desk = await machine(fake, 'desk');
  await signIn(fake, desk.google);
  await desk.manager.update({ mode: 'google', enabled: true });
  const chat = await source(desk.root, 'chats/one.jsonl', 'hello\n');
  await desk.manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'one' });
  const before = fake.files.size;
  const result = await desk.google.disconnect();
  assert.equal(result.revoked, true);
  assert.equal(fake.calls.revoke, 1);
  assert.equal((await desk.google.status()).state, 'disconnected');
  assert.equal(fake.files.size, before);
  const stored = JSON.parse(await readFile(join(desk.root, 'state', 'google-connection.json'), 'utf8')) as { refreshToken: string | null };
  assert.equal(stored.refreshToken, null);
});
