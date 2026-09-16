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
