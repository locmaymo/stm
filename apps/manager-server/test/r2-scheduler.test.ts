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

/**
 * A scheduler wired to a bucket that is on, with nothing due on any clock.
 *
 * `archived` is whether this installation has ever sent its usage log, which
 * is the only thing the first-upload rule turns on.
 */
function remoteScheduler(options: { archived: boolean; coldDue?: boolean }) {
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
    metricsArchived: async () => options.archived,
    syncMetricsFile: async (path: string) => { metricsSyncs.push(path); return null; },
    pruneDue: async () => false,
    reconcileDue: async () => false,
  } as unknown as R2Manager;
  const instance = new BackupScheduler({
    backups, profiles, r2, logger: () => undefined,
    saveSettings: async () => false,
    metricsFile: '/tmp/usage.jsonl',
  });
  return { metricsSyncs, instance };
}

test('the first usage log goes up without waiting for the slow clock', async () => {
  /*
   * Until it has been up once there is nothing in the bucket for a wiped
   * machine to come back to. A new installation on a new account - which is
   * every first run - was six hours away from having any history worth
   * keeping, so being wiped inside that window came back reading zero.
   */
  const { metricsSyncs, instance } = remoteScheduler({ archived: false });
  await instance.tick();
  assert.deepEqual(metricsSyncs, ['/tmp/usage.jsonl']);
});

test('once the usage log is in the bucket it goes back to the slow clock', async () => {
  // It is appended to on every request SillyTavern makes, so on the fast clock
  // it would be the only thing ever being sent.
  const quiet = remoteScheduler({ archived: true });
  await quiet.instance.tick();
  assert.deepEqual(quiet.metricsSyncs, [], 'nothing is due, so nothing is sent');

  const slow = remoteScheduler({ archived: true, coldDue: true });
  await slow.instance.tick();
  assert.deepEqual(slow.metricsSyncs, ['/tmp/usage.jsonl']);
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
