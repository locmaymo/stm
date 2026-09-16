import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackupStore } from '../../../packages/backup/src/index.js';
import type { ProcessSupervisor } from '../src/supervisor.js';
import { restoreWithProcess, RestoreRollbackError } from '../src/server.js';

const profile = { id: 'p1', name: 'Main' } as never;

function fakes(options: { rollbackFails?: boolean } = {}) {
  const controller = new AbortController();
  const restores: Array<{ path: string; mode: string }> = [];
  let starts = 0;
  const backups = {
    reserve: () => () => undefined,
    createSafetyCopy: async () => ({ id: 'safety', name: 'Main-prerestore' }),
    getArchivePath: async (id: string) => `/archives/${id}.zip`,
    restore: async (_profile: unknown, path: string, restoreOptions: { mode: string }) => {
      restores.push({ path, mode: restoreOptions.mode });
      if (path === '/archives/chosen.zip') {
        // The operator presses Stop while files are being written.
        controller.abort();
        throw new Error('The operation was stopped');
      }
      if (options.rollbackFails) throw new Error('disk full');
      return { fileCount: 1 };
    },
  } as unknown as BackupStore;
  const supervisor = {
    stop: async () => ({ status: 'stopped' }),
    start: async () => { starts += 1; return { status: 'running' }; },
    getState: () => ({ status: 'stopped' }),
  } as unknown as ProcessSupervisor;
  return { controller, restores, backups, supervisor, starts: () => starts };
}

test('a restore stopped while writing puts the safety copy back before SillyTavern starts', async () => {
  const { controller, restores, backups, supervisor, starts } = fakes();
  await assert.rejects(() => restoreWithProcess({ profile, backups, supervisor, archivePath: '/archives/chosen.zip', mode: 'merge', signal: controller.signal }), /stopped/u);
  assert.deepEqual(restores, [{ path: '/archives/chosen.zip', mode: 'merge' }, { path: '/archives/safety.zip', mode: 'replace' }]);
  assert.equal(starts(), 1);
});

test('a stopped restore that cannot be put back says so', async () => {
  const { controller, backups, supervisor, starts } = fakes({ rollbackFails: true });
  await assert.rejects(() => restoreWithProcess({ profile, backups, supervisor, archivePath: '/archives/chosen.zip', mode: 'replace', signal: controller.signal }), RestoreRollbackError);
  assert.equal(starts(), 1);
});
