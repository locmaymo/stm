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
    const url = new URL(connection.beginConnect('https://tunnel.example.com/panel'));
    await connection.completeConnect({ state: url.searchParams.get('state') ?? '', code: 'good-code' });
    const r2 = new R2Manager({ paths, env: {}, logger: () => undefined, fetchImpl: cloudflare.fetchImpl, cloudflare: connection, installationLabel: label, now: () => new Date(clock.now) });
    await r2.update({ mode: 'cloudflare', enabled: true });
    return { connection, r2, paths };
  };
  return { cloudflare, first: await machine('laptop'), second: await machine('studio') };
}

test('one machine backs up to an account, and the second is told whose it is', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { first, second } = await twoMachines(clock);

  const claimed = await first.r2.inspect();
  assert.equal(claimed.ok, true, claimed.failure?.message ?? '');
  assert.deepEqual((await first.r2.getConfig()).owner, { label: 'laptop', lastSeenAt: new Date(clock.now).toISOString(), mine: true });

  // The second machine reaches the same bucket through the same account and
  // stops rather than collecting the first one's chunks behind its back.
  const refused = await second.r2.inspect();
  assert.equal(refused.ok, false);
  assert.equal(refused.failure?.code, 'r2_in_use');
  const seen = (await second.r2.getConfig()).owner;
  assert.equal(seen?.label, 'laptop');
  assert.equal(seen?.mine, false);
  await assert.rejects(second.r2.reconcile(), (error: unknown) => error instanceof R2Error && error.code === 'r2_in_use');

  // Taking over is asked for by hand, and takes the other machine's key off
  // the Worker so it stops at its next request rather than at its next check.
  const config = await second.r2.takeOwnership();
  assert.deepEqual(config.owner, { label: 'studio', lastSeenAt: new Date(clock.now).toISOString(), mine: true });
  assert.equal((await second.r2.inspect()).ok, true);

  // And now it is the first machine that stops.
  const turned = await first.r2.inspect();
  assert.equal(turned.ok, false);
  assert.equal(turned.failure?.code, 'r2_in_use');
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

  await first.r2.saveManagerSettings({
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
  });
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
  assert.equal((await first.r2.inspect()).ok, true);

  // The machine that held it is gone: a studio that does not keep its disk, a
  // computer somebody replaced. Nobody is there to press a button, and the
  // point of the bucket is that the data outlives the machine.
  clock.now += CLAIM_STALE_MS + 1000;
  const taken = await second.r2.inspect();
  assert.equal(taken.ok, true, taken.failure?.message ?? '');
  assert.deepEqual((await second.r2.getConfig()).owner, { label: 'studio', lastSeenAt: new Date(clock.now).toISOString(), mine: true });
});

test('signing out gives the bucket up, so the next machine does not have to take it', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const { first, second } = await twoMachines(clock);
  assert.equal((await first.r2.inspect()).ok, true);
  assert.equal((await second.r2.inspect()).failure?.code, 'r2_in_use');

  await first.r2.releaseOwnership();
  await first.connection.disconnect();
  assert.equal((await first.r2.getConfig()).owner, null);

  const now = await second.r2.inspect();
  assert.equal(now.ok, true, now.failure?.message ?? '');
  assert.equal((await second.r2.getConfig()).owner?.mine, true);
});
