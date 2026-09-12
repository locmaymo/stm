import test from 'node:test';
import assert from 'node:assert/strict';
import { createIoLimiter, detectPlatform, getPlatformPaths, ioConcurrency, runPooled } from '../../../packages/platform/src/index.js';

test('platform paths follow the documented durable roots', () => {
  assert.equal(detectPlatform({ platform: 'win32', env: {} }), 'windows');
  assert.equal(detectPlatform({ platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } }), 'termux');
  assert.equal(detectPlatform({ platform: 'linux', env: { STM_DATA_DIR: '/mnt/workspace/sillytavern-manager' } }), 'modelscope');
  assert.equal(detectPlatform({ platform: 'linux', env: { STM_DOCKER: '1' } }), 'docker');

  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: 'D:/manager-test-data' } });
  assert.match(paths.root, /manager-test-data$/);
  assert.match(paths.state, /state$/);
});

test('io concurrency accepts an operator override and ignores nonsense', () => {
  assert.equal(ioConcurrency({}), 8);
  assert.equal(ioConcurrency({ STM_IO_CONCURRENCY: '16' }), 16);
  assert.equal(ioConcurrency({ STM_IO_CONCURRENCY: '0' }), 8);
  assert.equal(ioConcurrency({ STM_IO_CONCURRENCY: '4096' }), 8);
  assert.equal(ioConcurrency({ STM_IO_CONCURRENCY: 'many' }), 8);
});

test('the pool runs every item, keeps the ceiling, and reports the first failure', async () => {
  const items = Array.from({ length: 50 }, (_, index) => index);
  const seen: number[] = [];
  const slots = new Set<number>();
  let active = 0;
  let peak = 0;
  await runPooled(items, 4, async (item, slot) => {
    slots.add(slot);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1); });
    seen.push(item);
    active -= 1;
  });
  assert.deepEqual([...seen].sort((left, right) => left - right), items);
  assert.equal(peak, 4);
  assert.deepEqual([...slots].sort(), [0, 1, 2, 3]);

  await assert.rejects(
    () => runPooled(items, 4, async (item) => { if (item === 7) throw new Error('boom'); await Promise.resolve(); }),
    (error: unknown) => error instanceof Error && error.message === 'boom',
  );
});

test('a shared limiter caps a recursive walk instead of multiplying per level', async () => {
  const limiter = createIoLimiter(3);
  let active = 0;
  let peak = 0;
  const work = async (): Promise<void> => limiter.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1); });
    active -= 1;
  });
  const descend = async (depth: number): Promise<void> => {
    await work();
    if (depth === 0) return;
    await Promise.all(Array.from({ length: 4 }, () => descend(depth - 1)));
  };
  await descend(3);
  assert.equal(peak, 3);
});
