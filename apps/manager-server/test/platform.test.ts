import test from 'node:test';
import { posix } from 'node:path';
import assert from 'node:assert/strict';
import { createIoLimiter, detectPlatform, getPlatformPaths, ioConcurrency, runPooled, storageAssurance, storageDurability } from '../../../packages/platform/src/index.js';

test('platform paths follow the documented durable roots', () => {
  assert.equal(detectPlatform({ platform: 'win32', env: {} }), 'windows');
  assert.equal(detectPlatform({ platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } }), 'termux');
  assert.equal(detectPlatform({ platform: 'linux', env: { STM_DATA_DIR: '/mnt/workspace/sillytavern-manager' } }), 'hosted');
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

test('whether the data survives a restart is asked of the filesystem, not the platform', () => {
  // A container's own writable layer, which is made with the container and
  // thrown away with it. Nothing in the environment says so; this does.
  const container = [
    'overlay / overlay rw,relatime,lowerdir=/x,upperdir=/y 0 0',
    'tmpfs /dev tmpfs rw,nosuid 0 0',
    'proc /proc proc rw,relatime 0 0',
  ].join('\n');
  assert.deepEqual(storageDurability('/data/sillytavern-manager', container), { durable: false, filesystem: 'overlay' });

  // The same image with a volume mounted at the data directory keeps its data,
  // and the deepest mount covering the directory is the one that decides.
  const withVolume = `${container}\n/dev/sdb /data ext4 rw,relatime 0 0`;
  assert.deepEqual(storageDurability('/data/sillytavern-manager', withVolume), { durable: true, filesystem: 'ext4' });
  // But only for what is under it: a sibling directory is still on the layer.
  assert.equal(storageDurability('/datastore/manager', withVolume).durable, false, 'a prefix of the name is not a prefix of the path');

  // Memory with a directory tree drawn on it is the other way to lose data.
  assert.equal(storageDurability('/tmp/manager', 'tmpfs /tmp tmpfs rw 0 0').durable, false);

  // An ordinary machine, and a mount point with a space in its name, which
  // /proc/mounts writes in octal.
  assert.deepEqual(storageDurability('/home/someone/.local/share/sillytavern-manager', '/dev/sda1 / ext4 rw 0 0'), { durable: true, filesystem: 'ext4' });
  assert.deepEqual(storageDurability('/mnt/my disk/manager', '/dev/sdc /mnt/my\\040disk xfs rw 0 0'), { durable: true, filesystem: 'xfs' });

  // A machine with no mount table to read is taken at its word. Telling
  // somebody their own disk might be wiped is worse than saying nothing.
  assert.deepEqual(storageDurability('C:/Users/someone/AppData/Local/SillyTavernManager', ''), { durable: true, filesystem: null });

  // The answer may not depend on which machine asked the question. A mount
  // table is a POSIX idea and its paths are POSIX paths, so an absolute one is
  // compared as written rather than run through the platform's own resolver -
  // which on Windows turns /data into \\data and matches nothing. This test
  // ran green on Linux and red on Windows CI until it did.
  assert.equal(posix.normalize('/data/sillytavern-manager'), '/data/sillytavern-manager');
  for (const root of ['/data/sillytavern-manager', '/data/./sillytavern-manager', '/data/nested/../sillytavern-manager']) {
    assert.deepEqual(storageDurability(root, container), { durable: false, filesystem: 'overlay' }, root);
  }
});

test('a machine is only vouched for when it is the reader’s own', () => {
  // A filesystem that is thrown away with the machine, wherever it is.
  assert.equal(storageAssurance('linux', { durable: false, filesystem: 'overlay' }), 'temporary');
  assert.equal(storageAssurance('hosted', { durable: false, filesystem: 'tmpfs' }), 'temporary');

  // An installation on somebody's own computer, on a filesystem that is
  // plainly a disk. The only case worth staying quiet about.
  assert.equal(storageAssurance('windows', { durable: true, filesystem: null }), 'durable');
  assert.equal(storageAssurance('linux', { durable: true, filesystem: 'ext4' }), 'durable');
  assert.equal(storageAssurance('termux', { durable: true, filesystem: 'f2fs' }), 'durable');

  /*
   * A container or a hosted workspace, on a volume that looks entirely real.
   *
   * This is the case the filesystem answer gets wrong: the mount says ext4
   * and the machine is still rebuilt from a checkout the next time somebody
   * opens it. No hosting platform is recognised by name here, so there is
   * nothing to check it against and the honest answer is that it is unknown.
   */
  assert.equal(storageAssurance('hosted', { durable: true, filesystem: 'ext4' }), 'unverified');
  assert.equal(storageAssurance('docker', { durable: true, filesystem: 'ext4' }), 'unverified');
  assert.equal(storageAssurance('unknown', { durable: true, filesystem: null }), 'unverified');
});
