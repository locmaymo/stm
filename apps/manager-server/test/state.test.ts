import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { StateStore } from '../src/state.js';

test('state survives a restart and keeps the setup code stable until setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-state-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const first = new StateStore({ paths, setupCode: 'stable-setup-code' });
  await first.load();
  assert.equal(first.getSetupCodeForTests(), 'stable-setup-code');

  const second = new StateStore({ paths, setupCode: 'different-process-code' });
  await second.load();
  assert.equal(second.getSetupCodeForTests(), 'stable-setup-code');
});
