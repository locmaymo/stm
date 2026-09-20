import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import type { Installation } from '../../../packages/contracts/src/index.js';
import { BackupStore } from '../../../packages/backup/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
import { StateStore } from '../src/state.js';
import { applyManagerSettings, currentManagerSettings, managerSettingsOffer, saveManagerSettings, type ManagerSettingsDeps } from '../src/manager-settings.js';
import { hashPassword, verifyPassword } from '../src/password.js';

const CREDENTIALS = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'stm-test-bucket',
  accessKeyId: 'access-key-1234',
  secretAccessKey: 'secret-key-5678',
  enabled: true,
} as const;

/** One bucket, shared by every manager a test makes. */
function sharedBucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
    }
    if (method === 'PUT') {
      objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer()));
      return new Response('', { status: 200 });
    }
    if (method === 'GET') {
      const body = objects.get(key);
      if (!body) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    }
    return new Response('', { status: 200 });
  };
  return { fetchImpl, objects };
}

const INSTALLATION = { id: 'install-1', selector: 'latest', status: 'ready' } as unknown as Installation;

async function machine(fetchImpl: typeof fetch, label: string): Promise<ManagerSettingsDeps> {
  const root = await mkdtemp(join(tmpdir(), `stm-mgr-${label}-`));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new StateStore({ paths });
  await store.load();
  const backups = new BackupStore({ paths, logger: () => undefined });
  const r2 = new R2Manager({ paths, env: { STM_DATA_DIR: root }, logger: () => undefined, fetchImpl, installationLabel: label });
  await r2.update({ ...CREDENTIALS });
  const runtime = { getActiveInstallation: async () => INSTALLATION } as unknown as RuntimeManager;
  return { store, backups, r2, runtime, logger: () => undefined };
}

test('a machine that is gone leaves behind enough to be a machine again', async () => {
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');

  // The laptop as somebody actually set it up: a console password, a passcode
  // on the door in front of SillyTavern, reachable over the house Wi-Fi, a
  // slower backup schedule than the default.
  await laptop.store.saveAdminPassword(hashPassword('console password'));
  await laptop.store.setAccessPassword(hashPassword('123456'), true);
  await laptop.store.setAccessLan(true);
  await laptop.store.setAutoStartSillyTavern(false);
  await laptop.backups.setSchedule({ intervalMinutes: 180 });
  await laptop.r2.update({ hotIntervalMinutes: 15, keepDaily: 7 });
  assert.equal(await saveManagerSettings(laptop), true);

  // A different computer, set up from nothing an hour later. It has its own
  // console password and knows nothing about the laptop.
  const desktop = await machine(bucket.fetchImpl, 'desktop');
  await desktop.store.saveAdminPassword(hashPassword('a different password'));

  const offer = await managerSettingsOffer(desktop);
  assert.equal(offer.available, true);
  assert.equal(offer.label, 'laptop');
  assert.equal(offer.mine, false, 'these are somebody else’s settings, and saying so is the point');
  assert.equal(offer.hasAdminPassword, true);

  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  const result = await applyManagerSettings(desktop, record, { passwords: true, schedules: true, ports: { manager: 7860, access: 8001 } });
  assert.ok(result.applied.includes('managerPassword'));

  const state = await desktop.store.getPersisted();
  assert.ok(state.adminPasswordHash && verifyPassword('console password', state.adminPasswordHash), 'the password from the laptop opens this console');
  assert.ok(state.accessPasswordHash && verifyPassword('123456', state.accessPasswordHash));
  assert.equal(state.accessPasscode, true);
  assert.equal(state.accessLanEnabled, true);
  assert.equal(state.autoStartSillyTavern, false);
  assert.equal((await desktop.backups.getSchedule()).intervalMinutes, 180);
  assert.equal((await desktop.r2.getConfig()).schedule.hotIntervalMinutes, 15);
  assert.equal((await desktop.r2.getConfig()).retention.keepDaily, 7);

  // And now it is this machine's record, so it is not offered again.
  assert.equal((await managerSettingsOffer(desktop)).mine, true);
});

test('only the parts that were asked for are put back', async () => {
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');
  await laptop.store.saveAdminPassword(hashPassword('console password'));
  await laptop.backups.setSchedule({ intervalMinutes: 180 });
  await saveManagerSettings(laptop);

  // Somebody who has already set this machine up and only wants the schedules
  // back does not want to be signed out of the console they are looking at.
  const desktop = await machine(bucket.fetchImpl, 'desktop');
  await desktop.store.saveAdminPassword(hashPassword('mine, and staying'));
  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  await applyManagerSettings(desktop, record, { passwords: false, schedules: true, ports: { manager: 7860, access: 8001 } });

  const state = await desktop.store.getPersisted();
  assert.ok(state.adminPasswordHash && verifyPassword('mine, and staying', state.adminPasswordHash));
  assert.equal((await desktop.backups.getSchedule()).intervalMinutes, 180);
});

test('a port this machine cannot have is reported rather than taken', async () => {
  const bucket = sharedBucket();
  const laptop = await machine(bucket.fetchImpl, 'laptop');
  // The laptop ran SillyTavern on the port that is this machine's console.
  await laptop.store.setSillyTavernPort(7860);
  await saveManagerSettings(laptop);

  const desktop = await machine(bucket.fetchImpl, 'desktop');
  const before = (await desktop.store.getPersisted()).sillyTavernPort;
  const record = await desktop.r2.loadManagerSettings();
  assert.ok(record);
  const result = await applyManagerSettings(desktop, record, { passwords: false, schedules: false, ports: { manager: 7860, access: 8001 } });

  assert.ok(result.skipped.includes('sillyTavernPort'));
  assert.equal((await desktop.store.getPersisted()).sillyTavernPort, before, 'the port that works here is kept');
});

test('what is sent is what the manager is actually set to', async () => {
  const bucket = sharedBucket();
  const only = await machine(bucket.fetchImpl, 'laptop');
  await only.store.setSillyTavernPort(8123);
  const record = await currentManagerSettings(only);
  assert.equal(record.sillyTavernPort, 8123);
  assert.equal(record.versionSelector, 'latest');
  // Nothing is invented: a manager with no password set says so rather than
  // sending an empty string that would restore as a password of nothing.
  assert.equal(record.adminPasswordHash, null);
});
