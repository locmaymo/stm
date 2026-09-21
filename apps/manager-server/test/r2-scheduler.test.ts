import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackupStore } from '../../../packages/backup/src/index.js';
import type { ProfileStore } from '../../../packages/profiles/src/index.js';
import type { R2Manager } from '../../../packages/r2/src/index.js';
import { BackupScheduler } from '../src/r2-scheduler.js';

function scheduler(intervalMinutes: number) {
  const created: string[] = [];
  const backups = {
    isOperationRunning: () => false,
    pruneCreated: async () => 0,
    fingerprint: async () => 'changed',
    getSchedule: async () => ({ intervalMinutes }),
    list: async () => [],
    create: async (_profile: unknown, options: { kind: string }) => { created.push(options.kind); return { name: options.kind }; },
  } as unknown as BackupStore;
  const profiles = { getActive: async () => ({ id: 'p1', name: 'Main' }) } as unknown as ProfileStore;
  const r2 = { getConfig: async () => ({ enabled: false, configured: false }) } as unknown as R2Manager;
  return { created, instance: new BackupScheduler({ backups, profiles, r2, logger: () => undefined }) };
}

test('a scheduled local backup is taken when one is due', async () => {
  const { created, instance } = scheduler(60);
  await instance.tick();
  assert.deepEqual(created, ['scheduled']);
});

test('a local schedule that was turned off takes nothing', async () => {
  const { created, instance } = scheduler(0);
  await instance.tick();
  assert.deepEqual(created, []);
});

/** A scheduler wired to a bucket that is on, with nothing due on any clock. */
function remoteScheduler(options: { coldDue?: boolean; now?: () => Date } = {}) {
  const metricsSyncs: string[] = [];
  const backups = {
    isOperationRunning: () => false,
    pruneCreated: async () => 0,
    fingerprint: async () => 'unchanged',
    getSchedule: async () => ({ intervalMinutes: 0 }),
    list: async () => [],
  } as unknown as BackupStore;
  const profiles = { getActive: async () => ({ id: 'p1', name: 'Main' }) } as unknown as ProfileStore;
  const r2 = {
    // Nothing has moved since the last run, so the profile itself is not due.
    getConfig: async () => ({ enabled: true, configured: true, schedule: { hotIntervalMinutes: 5 }, lastFingerprint: 'unchanged' }),
    coldDue: async () => options.coldDue ?? false,
    syncMetricsFile: async (path: string) => { metricsSyncs.push(path); return null; },
    pruneDue: async () => false,
    reconcileDue: async () => false,
  } as unknown as R2Manager;
  const instance = new BackupScheduler({
    backups, profiles, r2, logger: () => undefined,
    saveSettings: async () => false,
    metricsFile: '/tmp/usage.jsonl',
    ...(options.now ? { now: options.now } : {}),
  });
  return { metricsSyncs, instance };
}

test('the usage log goes up on a clock of its own, not on the slow tier', async () => {
  /*
   * It used to ride the six-hour clock, so a machine wiped inside that window
   * came back reading zero - which is the state every new installation starts
   * in, on an account that is also new. Sending it costs a hash of a local
   * file and, when it has actually grown, one chunk and one small index; a
   * quarter of an hour of that is a rounding error against a free month.
   */
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const { metricsSyncs, instance } = remoteScheduler({ now: () => new Date(clock) });

  // The first tick, whatever the clock says: until it has been up once there
  // is nothing in the bucket for a wiped machine to come back to.
  await instance.tick();
  assert.deepEqual(metricsSyncs, ['/tmp/usage.jsonl']);

  // A minute later it is not due again, so the tick costs nothing.
  clock += 60_000;
  await instance.tick();
  assert.equal(metricsSyncs.length, 1);

  clock += 15 * 60_000;
  await instance.tick();
  assert.equal(metricsSyncs.length, 2);
});

test('the usage log goes up on a machine with nothing installed', async () => {
  // It is not profile data, so waiting for a profile meant a machine somebody
  // was in the middle of setting up recorded usage and sent none of it.
  const metricsSyncs: string[] = [];
  const scheduler = new BackupScheduler({
    backups: {
      isOperationRunning: () => false,
      pruneCreated: async () => 0,
      fingerprint: async () => 'unchanged',
      getSchedule: async () => ({ intervalMinutes: 0 }),
      list: async () => [],
    } as unknown as BackupStore,
    profiles: { getActive: async () => null } as unknown as ProfileStore,
    r2: {
      getConfig: async () => ({ enabled: true, configured: true, schedule: { hotIntervalMinutes: 5 }, lastFingerprint: null }),
      syncMetricsFile: async (path: string) => { metricsSyncs.push(path); return null; },
    } as unknown as R2Manager,
    logger: () => undefined,
    saveSettings: async () => false,
    metricsFile: '/tmp/usage.jsonl',
  });

  await scheduler.tick();
  assert.deepEqual(metricsSyncs, ['/tmp/usage.jsonl']);
});

test('the manager’s own settings go up before there is anything installed', async () => {
  /*
   * The settings used to be saved after the profile check, which returns early
   * on a machine with nothing installed - and that is exactly the machine
   * whose settings are worth having somewhere else, because it is a machine
   * somebody is in the middle of setting up. Whoever set a password, moved
   * SillyTavern's port and turned the tunnel on, and was then wiped before the
   * install finished, came back to none of it: the first upload of any of it
   * was waiting on a profile that did not exist yet.
   */
  let saves = 0;
  const backups = {
    isOperationRunning: () => false,
    pruneCreated: async () => 0,
    fingerprint: async () => 'unchanged',
    getSchedule: async () => ({ intervalMinutes: 0 }),
    list: async () => [],
  } as unknown as BackupStore;
  const scheduler = new BackupScheduler({
    backups,
    profiles: { getActive: async () => null } as unknown as ProfileStore,
    r2: {
      getConfig: async () => ({ enabled: true, configured: true, schedule: { hotIntervalMinutes: 5 }, lastFingerprint: null }),
    } as unknown as R2Manager,
    logger: () => undefined,
    saveSettings: async () => { saves += 1; return true; },
  });

  await scheduler.tick();
  assert.equal(saves, 1);
});

test('a bucket that is off is not written to at all', async () => {
  // The settings moving ahead of the profile must not turn a manager with no
  // bucket into one that asks about one on every tick.
  let saves = 0;
  const scheduler = new BackupScheduler({
    backups: {
      isOperationRunning: () => false,
      pruneCreated: async () => 0,
      fingerprint: async () => 'unchanged',
      getSchedule: async () => ({ intervalMinutes: 0 }),
      list: async () => [],
    } as unknown as BackupStore,
    profiles: { getActive: async () => null } as unknown as ProfileStore,
    r2: { getConfig: async () => ({ enabled: false, configured: false, schedule: { hotIntervalMinutes: 5 }, lastFingerprint: null }) } as unknown as R2Manager,
    logger: () => undefined,
    saveSettings: async () => { saves += 1; return true; },
  });

  await scheduler.tick();
  assert.equal(saves, 0);
});
