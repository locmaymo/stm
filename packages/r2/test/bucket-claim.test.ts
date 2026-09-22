import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCOPES } from '../../cloudflare/src/index.js';
import { getPlatformPaths } from '../../platform/src/index.js';
import { CloudflareConnection } from '../src/cloudflare-connection.js';
import { R2Manager } from '../src/index.js';
import { R2Error } from '../src/store.js';
import { CLAIM_STALE_MS } from '../src/owner.js';
import { fakeCloudflare } from './cloudflare-fake.js';

const CLIENT = { clientId: 'client-1', redirectUri: 'https://stm.example.com/oauth/cloudflare/callback', scopes: Object.values(DEFAULT_SCOPES) };

const SETTINGS = {
  schemaVersion: 1,
  installId: 'install-under-test',
  tunnelQuick: false,
  managerTunnelQuick: false,
  adminPasswordHash: 'scrypt$16384$8$1$salt$key',
  accessPasswordHash: null,
  accessPasscode: false,
  accessLanEnabled: true,
  autoStartSillyTavern: true,
  sillyTavernPort: 8002,
  localIntervalMinutes: 60,
  r2: { hotIntervalMinutes: 5, coldIntervalHours: 6, reconcileIntervalHours: 24, keepRecent: 24, keepDaily: 30, keepWeekly: 0, maxStorageBytes: 8_000_000_000, maxWriteOperations: 800_000, maxReadOperations: 8_000_000 },
  versionSelector: 'latest',
  versionRef: '1.13.2',
} as const;

/**
 * Two managers, one Cloudflare account, one bucket.
 *
 * Each gets its own data directory, which is what gives it its own
 * installation key - the same thing that happens when somebody sets the
 * manager up on a second computer, or when a hosted machine comes back with
 * its disk emptied.
 */
async function twoMachines(clock: { now: number }) {
  const cloudflare = await fakeCloudflare();
  const machine = async (label: string) => {
    const root = await mkdtemp(join(tmpdir(), `stm-claim-${label}-`));
    const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
    const connection = new CloudflareConnection({ paths, client: CLIENT, fetchImpl: cloudflare.fetchImpl, now: () => clock.now, sleep: async () => undefined });
    const r2 = new R2Manager({ paths, env: {}, logger: () => undefined, fetchImpl: cloudflare.fetchImpl, cloudflare: connection, installationLabel: label, now: () => new Date(clock.now) });
    /*
     * One whole sign-in, and what the server does the moment one finishes.
     *
     * Taking the claim is not a separate decision anybody makes: holding the
     * account is what makes somebody the owner, and their newest manager is
     * the one they mean. So the two happen together here as they do in
     * `claimForThisMachine`, and a test that says "and then they signed in on
     * the other machine" can say exactly that.
     */
    const connect = async (): Promise<void> => {
      const url = new URL(connection.beginConnect('https://tunnel.example.com/panel'));
      await connection.completeConnect({ state: url.searchParams.get('state') ?? '', code: 'good-code' });
      await r2.update({ mode: 'cloudflare', enabled: true });
    };
    const signIn = async (): Promise<void> => { await connect(); await r2.takeOwnership(); };
    return { connection, r2, paths, connect, signIn };
  };
  return { cloudflare, first: await machine('laptop'), second: await machine('studio') };
}

test('one machine backs up to an account, and the second is told whose it is', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { first, second } = await twoMachines(clock);

  await first.signIn();
  const claimed = await first.r2.inspect();
  assert.equal(claimed.ok, true, claimed.failure?.message ?? '');
  assert.deepEqual((await first.r2.getConfig()).owner, { label: 'laptop', lastSeenAt: new Date(clock.now).toISOString(), mine: true });

  // Somebody sets the manager up on a second machine and signs in with the
  // same account. Nobody is asked: holding the account is what makes somebody
  // the owner, and the machine they are sitting in front of is the one they
  // mean. The claim moves, and the other machine's Worker key goes with it.
  await second.signIn();
  assert.deepEqual((await second.r2.getConfig()).owner, { label: 'studio', lastSeenAt: new Date(clock.now).toISOString(), mine: true });
  assert.equal((await second.r2.inspect()).ok, true);

  /*
   * And now it is the first machine that stops - knowing why, and by whom.
   *
   * This is the half that was missing. The first machine went on backing up
   * until a request came back `401 unauthorized`, which named nobody and left
   * nothing to press. The fact is in the claim, so the refusal carries the
   * other machine's name and the one thing there is to do about it.
   */
  const turned = await first.r2.inspect();
  assert.equal(turned.ok, false);
  assert.equal(turned.failure?.code, 'r2_in_use');
  assert.match(turned.failure?.message ?? '', /studio/u);
  assert.match(turned.failure?.message ?? '', /Sign in to Cloudflare again/u);
  assert.equal((await first.r2.getConfig()).owner?.mine, false);
});

/*
 * Losing the account means losing the account, not only the backups.
 *
 * The grant reaches everything the account has: the Workers that give the
 * tunnels a fixed address, the objects in the bucket over the REST API, the
 * usage figures. A manager that went on holding it after another machine took
 * the claim was still deploying into an account that was no longer its to
 * touch - and still telling the reader its backups were merely going the
 * slower way, which is the one sentence it had for a Worker that would not
 * answer. So the credentials go, at the first look, and the only thing left
 * that works is signing in again.
 */
test('the machine that lost the account keeps nothing to reach it with', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { first, second } = await twoMachines(clock);
  await first.signIn();
  await second.signIn();

  // Opening the console is the whole of what happens on a manager with
  // nothing to send, and it is enough to find out.
  await first.r2.refreshClaim();
  const lost = await first.connection.status();
  assert.equal(lost.state, 'reconnect_required');
  assert.equal(lost.displacedBy, 'studio');
  // Which is also the end of "backups are going the slower way for now": that
  // notice belongs to a connection that still works.
  assert.equal(lost.restReason, null);

  // Nothing else in the account either. The fixed-address Workers have no
  // account to deploy into, and no request reaches the bucket by any road.
  assert.equal(await first.connection.workersAccount(), null);
  const reconnect = (error: unknown): boolean => error instanceof R2Error && error.code === 'cloudflare_reconnect_required';
  await assert.rejects(first.r2.reconcile(), reconnect);
  await assert.rejects(first.r2.loadManagerSettings(), reconnect);
  await assert.rejects(first.r2.listObjects(), reconnect);
  assert.equal((await first.r2.inspect()).ok, false);
  // Including the record that describes a machine. It is the one write that
  // used to go through without reading the claim, so the machine that had
  // been locked out went on replacing the setup of the machine that had
  // taken over - which is what the other one's console was offering to
  // restore from.
  assert.equal(await first.r2.saveManagerSettings({ ...SETTINGS, installId: 'laptop-install' }), false);
  const kept = await second.r2.loadManagerSettings();
  assert.notEqual(kept?.installId, 'laptop-install');

  // And signing in here again is the way back, because it is the same rule
  // read the other way round: this is now the newest sign-in.
  await first.signIn();
  assert.equal((await first.r2.inspect()).ok, true);
  assert.equal((await first.connection.status()).displacedBy, null);
  assert.equal((await first.r2.getConfig()).owner?.mine, true);
});

/*
 * Who signed in last decides it - not who reached the bucket first.
 *
 * Taking the claim is a Worker deploy and a write, and the console that came
 * back from Cloudflare a second earlier is already asking who holds the
 * account. So the machine that had just signed in could read the old
 * machine's claim before its own sign-in had finished writing one, believe
 * it, and give up the grant it had been opened with - and then carry, on the
 * console it had just been opened on, the notice saying it had been replaced
 * by the machine it was itself replacing. Which is what a reader saw: the red
 * notice on the new machine, and the old one carrying on as though it had
 * just taken over.
 *
 * Two timestamps settle it instead, the same way whoever asks first.
 */
test('a sign-in that lost the race to the bucket still holds the account', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { first, second } = await twoMachines(clock);
  await first.signIn();

  // The second machine signs in, and the takeover does not happen: the write
  // is still in flight, or it failed, or the console got there first.
  clock.now += 60_000;
  await second.connect();

  // What the console asks as it opens. It must not read the claim it is about
  // to replace as somebody else holding the account.
  await second.r2.refreshClaim();
  assert.equal((await second.connection.status()).state, 'connected');
  assert.equal((await second.r2.getConfig()).owner?.mine, true);

  // And the first thing it writes repairs the claim rather than being refused
  // by it, so the machine does not sit locked out of an account it holds.
  const checked = await second.r2.inspect();
  assert.equal(checked.ok, true, checked.failure?.message ?? '');
  assert.deepEqual((await second.r2.getConfig()).owner, { label: 'studio', lastSeenAt: new Date(clock.now).toISOString(), mine: true });

  // The older sign-in is the one that gives way, which is the whole rule.
  const turned = await first.r2.inspect();
  assert.equal(turned.ok, false);
  assert.equal(turned.failure?.code, 'r2_in_use');
  assert.equal((await first.connection.status()).displacedBy, 'studio');
});

/*
 * The two documents this manager keeps beside the recovery points go through
 * the Worker like everything else, and the Worker refuses any key outside the
 * manager's own prefix. Every other test of them talks to an S3 fake, which
 * would not notice that rule - so both are written and read back here, through
 * the deployed Worker source, on a signed-in account.
 */
test('what the bucket remembers about the account goes through the Worker too', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { cloudflare, first } = await twoMachines(clock);
  await first.signIn();

  await first.r2.saveManagerSettings({ ...SETTINGS });
  const settings = await first.r2.loadManagerSettings();
  assert.equal(settings?.label, 'laptop');
  assert.equal(settings?.accessLanEnabled, true);

  // Checking the bucket settles up the count of charged operations, which is
  // the other document; both keys are under the prefix the Worker allows.
  const checked = await first.r2.inspect();
  assert.equal(checked.ok, true, checked.failure?.message ?? '');
  assert.equal(checked.usage?.sharedRecord, true);

  const keys = [...cloudflare.state.buckets.values()].flatMap((bucket) => [...bucket.objects.keys()]);
  assert.ok(keys.includes('sillytavern-manager/manager.json'), keys.join(', '));
  assert.ok(keys.includes('sillytavern-manager/usage.json'), keys.join(', '));
});

test('a claim nobody has refreshed for days is taken without asking', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { first, second } = await twoMachines(clock);
  await first.signIn();
  assert.equal((await first.r2.inspect()).ok, true);

  // The machine that held it is gone: a studio that does not keep its disk, a
  // computer somebody replaced. Nobody is there to press a button, and the
  // point of the bucket is that the data outlives the machine.
  clock.now += CLAIM_STALE_MS + 1000;
  await second.connect();
  const taken = await second.r2.inspect();
  assert.equal(taken.ok, true, taken.failure?.message ?? '');
  assert.deepEqual((await second.r2.getConfig()).owner, { label: 'studio', lastSeenAt: new Date(clock.now).toISOString(), mine: true });
});

test('signing out gives the bucket up, so the next machine does not have to take it', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { first, second } = await twoMachines(clock);
  await first.signIn();
  assert.equal((await first.r2.inspect()).ok, true);
  await second.connect();
  assert.equal((await second.r2.inspect()).failure?.code, 'r2_in_use');

  await first.r2.releaseOwnership();
  await first.connection.disconnect();
  assert.equal((await first.r2.getConfig()).owner, null);

  // Nobody holds the bucket now, so the machine that was turned away signs in
  // and simply has it: no claim to argue with, nothing to take over.
  await second.connect();
  const now = await second.r2.inspect();
  assert.equal(now.ok, true, now.failure?.message ?? '');
  assert.equal((await second.r2.getConfig()).owner?.mine, true);
});
