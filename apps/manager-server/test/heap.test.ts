import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sillyTavernHeapMb } from '../src/heap.js';
import { largestDataFile } from '../src/server.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

test('the Android app gives SillyTavern half the phone, never less than Node would, never more than 4 GiB', () => {
  const android = { STM_ANDROID_APP: '1' };
  // A 4 GB phone: Node alone gives 1,077 MiB, measured in the app.
  assert.equal(sillyTavernHeapMb(android, { totalBytes: 4 * GIB, defaultLimitBytes: 1077 * MIB }), 2048);
  assert.equal(sillyTavernHeapMb(android, { totalBytes: 3 * GIB, defaultLimitBytes: 800 * MIB }), 1536);
  assert.equal(sillyTavernHeapMb(android, { totalBytes: 16 * GIB, defaultLimitBytes: 4144 * MIB }), null, 'Node already gives more than the ceiling');
  assert.equal(sillyTavernHeapMb(android, { totalBytes: 12 * GIB, defaultLimitBytes: 3000 * MIB }), 4096);
  assert.equal(sillyTavernHeapMb(android, { totalBytes: 1.5 * GIB, defaultLimitBytes: 800 * MIB }), null, 'half would be less than Node gives');
});

test('a computer or a hosted container keeps Node’s default, and an explicit size wins anywhere', () => {
  assert.equal(sillyTavernHeapMb({}, { totalBytes: 4 * GIB, defaultLimitBytes: 1077 * MIB }), null);
  assert.equal(sillyTavernHeapMb({ STM_SILLYTAVERN_HEAP_MB: '3000' }), 3000);
  assert.equal(sillyTavernHeapMb({ STM_SILLYTAVERN_HEAP_MB: '3000', STM_ANDROID_APP: '1' }), 3000);
  assert.equal(sillyTavernHeapMb({ STM_SILLYTAVERN_HEAP_MB: '64' }), null, 'too small to start on is not taken');
  assert.equal(sillyTavernHeapMb({ STM_ANDROID_APP: '1', NODE_OPTIONS: '--max-old-space-size=1500' }, { totalBytes: 4 * GIB, defaultLimitBytes: 1077 * MIB }), null, 'a size set by hand stands');
});

test('the file named when SillyTavern runs out of memory is the largest chat or settings file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-largest-'));
  const put = async (name: string, bytes: number): Promise<void> => {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), 'x'.repeat(bytes), 'utf8');
  };
  await put('settings.json', 3_000);
  await put('chats/Seraphina/long.jsonl', 9_000);
  await put('chats/Seraphina/short.jsonl', 100);
  // Larger, but never read whole into memory: not the answer.
  await put('backups/chat_Seraphina_backup.jsonl', 50_000);
  await put('backgrounds/wallpaper.png', 80_000);
  await put('extensions/some-extension/data.json', 40_000);
  assert.deepEqual(await largestDataFile(root), { name: 'chats/Seraphina/long.jsonl', bytes: 9_000 });
  assert.equal(await largestDataFile(join(root, 'missing')), null);
});
