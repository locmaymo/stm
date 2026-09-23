import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupError, BackupStore } from '../../../packages/backup/src/index.js';
import type { ProfileStore } from '../../../packages/profiles/src/index.js';
import type { R2Manager } from '../../../packages/r2/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import type { ProcessSupervisor } from '../src/supervisor.js';
import { BackupScheduler } from '../src/r2-scheduler.js';
import { SAVER_MEMORY_THRESHOLD_BYTES, SaverMode } from '../src/saver.js';
import { restoreWithProcess, RestoreRollbackError } from '../src/server.js';
import { StateStore } from '../src/state.js';

const small = SAVER_MEMORY_THRESHOLD_BYTES - 1;
const large = SAVER_MEMORY_THRESHOLD_BYTES * 4;

test('a machine with little memory is in saver mode until somebody says otherwise', () => {
  const saver = new SaverMode({ env: {}, choice: null, memoryBytes: small });
  assert.equal(saver.enabled, true);
  assert.equal(saver.source, 'memory');
  assert.equal(new SaverMode({ env: {}, choice: null, memoryBytes: large }).enabled, false);
});

test('the panel’s switch overrides the memory, and STM_SAVER overrides both', () => {
  const chosen = new SaverMode({ env: {}, choice: false, memoryBytes: small });
  assert.equal(chosen.enabled, false);
  assert.equal(chosen.source, 'choice');
  chosen.choose(true);
  assert.equal(chosen.enabled, true);

  const forced = new SaverMode({ env: { STM_SAVER: '0' }, choice: true, memoryBytes: small });
  assert.equal(forced.enabled, false);
  assert.equal(forced.locked, true);
  assert.equal(forced.source, 'environment');
  assert.equal(new SaverMode({ env: { STM_SAVER: 'true' }, choice: false, memoryBytes: large }).enabled, true);
  // Anything else is not an answer, and leaves the decision where it was.
  assert.equal(new SaverMode({ env: { STM_SAVER: 'maybe' }, choice: null, memoryBytes: large }).locked, false);
});

test('the panel’s choice survives a restart, and a file without one has none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-saver-state-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const first = new StateStore({ paths });
  assert.equal((await first.load()).saverMode, null);
  await first.setSaverMode(true);
  assert.equal((await new StateStore({ paths }).load()).saverMode, true);
});

test('saver mode writes no local archive, by hand or on the clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-saver-backup-'));
  const store = new BackupStore({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } }), logger: () => undefined });
  store.saving = true;
  await assert.rejects(() => store.create({ id: 'p1', name: 'Main' } as never), (error: unknown) => error instanceof BackupError && error.code === 'saver_mode');

  const created: string[] = [];
  const backups = {
    saving: true,
    isOperationRunning: () => false,
    pruneCreated: async () => 0,
    fingerprint: async () => 'changed',
    getSchedule: async () => ({ intervalMinutes: 60 }),
    list: async () => [],
    create: async (_profile: unknown, options: { kind: string }) => { created.push(options.kind); return { name: options.kind }; },
  } as unknown as BackupStore;
  const profiles = { getActive: async () => ({ id: 'p1', name: 'Main' }) } as unknown as ProfileStore;
  const r2 = { getConfig: async () => ({ enabled: false, configured: false }) } as unknown as R2Manager;
  await new BackupScheduler({ backups, profiles, r2, logger: () => undefined }).tick();
  assert.deepEqual(created, []);
});

function saverFakes() {
  const controller = new AbortController();
  const calls: string[] = [];
  const backups = {
    saving: true,
    reserve: () => () => undefined,
    reclassifyAsScheduled: async () => undefined,
    createSafetyCopy: async () => { calls.push('safety copy'); return { id: 'safety' }; },
    restore: async () => {
      calls.push('restore');
      controller.abort();
      throw new Error('The operation was stopped');
    },
  } as unknown as BackupStore;
  const supervisor = {
    stop: async () => ({ status: 'stopped' }),
    start: async () => { calls.push('start'); return { status: 'running' }; },
    getState: () => ({ status: 'stopped' }),
  } as unknown as ProcessSupervisor;
  return { controller, calls, backups, supervisor };
}

test('a saver mode restore keeps its copy in R2 rather than on the disk', async () => {
  const { controller, calls, backups, supervisor } = saverFakes();
  const safetyNet = async () => { calls.push('R2'); };
  // Stopped while writing, with no local copy to put back: said as such, not
  // reported as a clean stop.
  await assert.rejects(
    () => restoreWithProcess({ profile: { id: 'p1', name: 'Main' } as never, backups, supervisor, archivePath: '/archives/chosen.zip', mode: 'replace', signal: controller.signal, safetyNet }),
    RestoreRollbackError,
  );
  assert.deepEqual(calls, ['R2', 'restore', 'start']);
});

test('a saver mode restore whose R2 copy fails writes nothing', async () => {
  const { calls, backups, supervisor } = saverFakes();
  const safetyNet = async () => { throw new Error('R2 is unreachable'); };
  await assert.rejects(
    () => restoreWithProcess({ profile: { id: 'p1', name: 'Main' } as never, backups, supervisor, archivePath: '/archives/chosen.zip', mode: 'replace', safetyNet }),
    /unreachable/u,
  );
  assert.deepEqual(calls, ['start']);
});
