import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { StateStore } from '../src/state.js';
import { hashPassword, verifyPassword } from '../src/password.js';

test('state survives a restart and keeps the setup code stable until setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-state-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const first = new StateStore({ paths, setupCode: 'stable-setup-code' });
  await first.load();
  assert.equal(first.getInitialSetupCode(), 'stable-setup-code');

  const second = new StateStore({ paths, setupCode: 'different-process-code' });
  await second.load();
  assert.equal(second.getInitialSetupCode(), 'stable-setup-code');
});

test('manager password changes persist across a new state store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-state-password-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const first = new StateStore({ paths });
  await first.load();
  const original = hashPassword('123456');
  assert.equal(await first.saveAdminPassword(original), true);
  const changed = hashPassword('654321');
  assert.equal(await first.changeAdminPassword(changed), true);

  const second = new StateStore({ paths });
  const state = await second.load();
  assert.ok(state.adminPasswordHash);
  assert.equal(verifyPassword('654321', state.adminPasswordHash), true);
  assert.equal(verifyPassword('123456', state.adminPasswordHash), false);
});
