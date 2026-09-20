import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { ManagerSettingsRecord } from '../../contracts/src/index.js';
import { R2Manager } from '../src/index.js';
import { parseManagerSettings, settingsUnchanged } from '../src/manager-settings.js';

const CREDENTIALS = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'stm-test-bucket',
  accessKeyId: 'access-key-1234',
  secretAccessKey: 'secret-key-5678',
  enabled: true,
} as const;

const SETTINGS: Omit<ManagerSettingsRecord, 'label' | 'writtenAt'> = {
  schemaVersion: 1,
  adminPasswordHash: 'scrypt$16384$8$1$salt$key',
  accessPasswordHash: 'scrypt$16384$8$1$other$key',
  accessPasscode: true,
  accessLanEnabled: true,
  autoStartSillyTavern: false,
  sillyTavernPort: 8123,
  localIntervalMinutes: 120,
  r2: {
    hotIntervalMinutes: 10, coldIntervalHours: 12, reconcileIntervalHours: 48,
    keepRecent: 48, keepDaily: 14, keepWeekly: 8,
    maxStorageBytes: 5_000_000_000, maxWriteOperations: 500_000, maxReadOperations: 5_000_000,
  },
  versionSelector: 'staging',
};

function sharedBucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer>; writes: number } {
  const objects = new Map<string, Buffer>();
  const counters = { writes: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
    }
    if (method === 'PUT') {
      if (key.endsWith('manager.json')) counters.writes += 1;
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
  return { fetchImpl, objects, get writes() { return counters.writes; } };
}

async function machine(fetchImpl: typeof fetch, label: string): Promise<R2Manager> {
  const root = await mkdtemp(join(tmpdir(), `stm-settings-${label}-`));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const manager = new R2Manager({ paths, env: { STM_DATA_DIR: root }, logger: () => undefined, fetchImpl, installationLabel: label });
  await manager.update({ ...CREDENTIALS });
  return manager;
}

test('a record is checked field by field, and one with no timestamp is not a record', () => {
  assert.equal(parseManagerSettings({ label: 'laptop' }), null);
  const salvaged = parseManagerSettings({ writtenAt: '2026-09-19T09:00:00.000Z', sillyTavernPort: 'eight thousand', r2: { keepDaily: -1 } });
  // A field that is the wrong shape falls back to what this manager would have
  // done anyway rather than making the whole record unusable - these decide
  // what port SillyTavern starts on and how much of an allowance is spent.
  assert.equal(salvaged?.sillyTavernPort, 8002);
  assert.equal(salvaged?.r2.keepDaily, 30);
  assert.equal(salvaged?.label, 'another machine');
});

test('when the settings were written, and by whom, is not a reason to write them again', () => {
  const record: ManagerSettingsRecord = { ...SETTINGS, label: 'laptop', writtenAt: '2026-09-19T09:00:00.000Z' };
  assert.equal(settingsUnchanged(record, { ...record, label: 'studio', writtenAt: '2026-09-20T09:00:00.000Z' }), true);
  assert.equal(settingsUnchanged(record, { ...record, sillyTavernPort: 9000 }), false);
  assert.equal(settingsUnchanged(null, record), false);
});

test('one machine leaves its settings, and the next one finds them', async () => {
  const bucket = sharedBucket();
  const first = await machine(bucket.fetchImpl, 'laptop');

  assert.equal(await first.saveManagerSettings(SETTINGS), true);
  assert.ok(bucket.objects.has('sillytavern-manager/manager.json'));

  // Saying the same thing again costs nothing: the manager compares before it
  // writes, so a machine that restarts often does not pay for each start.
  assert.equal(await first.saveManagerSettings(SETTINGS), false);
  assert.equal(bucket.writes, 1);

  // A different machine entirely - a new computer, or a studio that starts
  // each time from nothing.
  const second = await machine(bucket.fetchImpl, 'studio');
  const found = await second.loadManagerSettings();
  assert.equal(found?.label, 'laptop');
  assert.equal(found?.accessPasswordHash, SETTINGS.accessPasswordHash);
  assert.equal(found?.accessPasscode, true);
  assert.equal(found?.sillyTavernPort, 8123);
  assert.equal(found?.r2.keepDaily, 14);
  assert.equal(found?.versionSelector, 'staging');
});

test('a bucket nobody has set up yet simply has nothing to offer', async () => {
  const bucket = sharedBucket();
  const only = await machine(bucket.fetchImpl, 'laptop');
  assert.equal(await only.loadManagerSettings(), null);
});

test('settings are not sent from a manager whose backups are switched off', async () => {
  const bucket = sharedBucket();
  const off = await machine(bucket.fetchImpl, 'laptop');
  await off.update({ enabled: false });
  // Nothing about this machine goes anywhere while it is told not to send
  // anything, which is the whole promise of that switch.
  assert.equal(await off.saveManagerSettings(SETTINGS), false);
  assert.equal(bucket.objects.has('sillytavern-manager/manager.json'), false);
});
