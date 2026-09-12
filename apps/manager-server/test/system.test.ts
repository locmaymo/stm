import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { SystemStore } from '../src/system.js';

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('the system snapshot reports the host and measures directory sizes in the background', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-system-'));
  const dataRoot = join(root, 'profiles', 'data');
  await mkdir(join(dataRoot, 'chats'), { recursive: true });
  await mkdir(join(dataRoot, 'node_modules'), { recursive: true });
  await writeFile(join(dataRoot, 'chats', 'one.jsonl'), 'x'.repeat(500), 'utf8');
  await writeFile(join(dataRoot, 'chats', 'two.jsonl'), 'x'.repeat(300), 'utf8');
  // Generated trees are not the operator's data and must not be counted.
  await writeFile(join(dataRoot, 'node_modules', 'ignored.bin'), 'x'.repeat(9_000), 'utf8');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new SystemStore({ paths, childPid: () => null, dataRoot: async () => dataRoot });

  const first = await store.snapshot();
  assert.ok(first.cpu.cores >= 1);
  // One reading of a counter since boot cannot describe the present.
  assert.equal(first.cpu.usagePercent, null);
  assert.equal(first.memory.usedBytes, first.memory.totalBytes - first.memory.freeBytes);
  assert.ok(first.memory.managerBytes > 0);
  assert.equal(first.storage.root, paths.root);
  assert.equal(first.storage.dataBytes, null);

  await settle();
  const second = await store.snapshot();
  assert.equal(second.storage.dataBytes, 800);
  assert.equal(second.storage.dataFileCount, 2);
  assert.ok((second.storage.managerBytes ?? 0) >= 800);
  assert.ok(second.storage.measuredAt !== null);
  assert.ok(second.cpu.usagePercent === null || (second.cpu.usagePercent >= 0 && second.cpu.usagePercent <= 100));
});
