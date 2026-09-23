import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { BackupError, BackupStore, type ArchiveStream } from '../src/index.js';

async function createProfile(name: string): Promise<{ root: string; profile: Profile; dataRoot: string; store: BackupStore }> {
  const root = await mkdtemp(join(tmpdir(), `stm-stream-${name}-`));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  const dataRoot = join(runtimePath, 'data', 'default-user');
  await mkdir(join(dataRoot, 'chats'), { recursive: true });
  const profile: Profile = {
    id: `profile-${name}`, name: 'Default', installationId: 'installation-1', runtimePath,
    configPath: join(runtimePath, 'config.yaml'), dataPath: join(runtimePath, 'data'), layout: 'data', active: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString(),
  };
  return { root, profile, dataRoot, store: new BackupStore({ paths, logger: () => undefined }) };
}

/** The archive from its central directory to its end, as the browser cuts it out. */
function tailOf(archive: Buffer): Buffer {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return archive.subarray(archive.readUInt32LE(eocd + 16));
}

/** Send the whole archive in chunks of `size`, the way the panel does. */
async function upload(stream: ArchiveStream, archive: Buffer, size: number): Promise<number> {
  let index = 0;
  for (let offset = 0; offset < archive.length; offset += size) {
    const result = await stream.push(index, archive.subarray(offset, offset + size));
    index += 1;
    if (result.done) break;
  }
  return index;
}

test('a zip is restored as it uploads, large files streamed and small ones gathered', async () => {
  const source = await createProfile('source');
  // Past the size a small entry is gathered at, so it takes the streamed path;
  // random, so deflate cannot make it small.
  const large = randomBytes(3 * 1024 * 1024);
  const chat = Buffer.from('{"line":1}\n'.repeat(5000));
  await writeFile(join(source.dataRoot, 'settings.json'), '{"theme":"dark"}', 'utf8');
  await writeFile(join(source.dataRoot, 'chats', 'Trò chuyện.jsonl'), chat);
  await writeFile(join(source.dataRoot, 'chats', 'empty.jsonl'), '');
  await mkdir(join(source.dataRoot, 'backgrounds'), { recursive: true });
  await writeFile(join(source.dataRoot, 'backgrounds', 'big.bin'), large);
  const manifest = await source.store.create(source.profile);
  const archive = await readFile((await source.store.getArchivePath(manifest.id))!);

  const target = await createProfile('target');
  target.store.saving = true;
  await writeFile(join(target.dataRoot, 'chats', 'stale.jsonl'), 'not in the backup');
  const stream = target.store.openStream(tailOf(archive), archive.length, 'data');
  assert.equal(stream.preview.fileCount, 4);
  assert.equal(stream.preview.recognized, true);
  // Nothing is ready for bytes until the restore has planned where they go.
  await assert.rejects(() => stream.push(0, archive.subarray(0, 10)), (error: unknown) => error instanceof BackupError && error.code === 'upload_not_ready');

  const restoring = target.store.restoreStream(target.profile, stream, { mode: 'replace' });
  assert.equal(await stream.whenReady(5000), true);
  // An odd chunk size, so headers and file bodies straddle chunk boundaries.
  await upload(stream, archive, 70_001);
  const preview = await restoring;
  assert.equal(preview.fileCount, 4);
  assert.equal(stream.done, true);

  assert.equal(await readFile(join(target.dataRoot, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.deepEqual(await readFile(join(target.dataRoot, 'chats', 'Trò chuyện.jsonl')), chat);
  assert.equal((await readFile(join(target.dataRoot, 'chats', 'empty.jsonl'))).length, 0);
  assert.deepEqual(await readFile(join(target.dataRoot, 'backgrounds', 'big.bin')), large);
  assert.deepEqual((await readdir(join(target.dataRoot, 'chats'))).sort(), ['Trò chuyện.jsonl', 'empty.jsonl']);
  // No zip was kept on the way.
  assert.deepEqual(await target.store.list(), []);
});

test('a chunk sent twice is taken once, and one out of order is refused', async () => {
  const source = await createProfile('retry-source');
  await writeFile(join(source.dataRoot, 'settings.json'), '{"a":1}', 'utf8');
  // Random, so it stays tens of chunks long once deflated.
  const chat = randomBytes(150_000).toString('base64');
  await writeFile(join(source.dataRoot, 'chats', 'one.jsonl'), chat);
  const manifest = await source.store.create(source.profile);
  const archive = await readFile((await source.store.getArchivePath(manifest.id))!);

  const target = await createProfile('retry-target');
  const stream = target.store.openStream(tailOf(archive), archive.length);
  const restoring = target.store.restoreStream(target.profile, stream, { mode: 'merge' });
  await stream.whenReady(5000);
  const size = 1000;
  await stream.push(0, archive.subarray(0, size));
  // The answer to chunk 0 was lost, so the browser sends it again.
  await stream.push(0, archive.subarray(0, size));
  // One from further on is refused, and the upload carries on from where it was.
  await assert.rejects(() => stream.push(5, archive.subarray(5 * size, 6 * size)), (error: unknown) => error instanceof BackupError && error.code === 'invalid_upload_chunk');
  for (let index = 1; index * size < archive.length && !stream.done; index += 1) await stream.push(index, archive.subarray(index * size, (index + 1) * size));
  await restoring;
  assert.equal(await readFile(join(target.dataRoot, 'chats', 'one.jsonl'), 'utf8'), chat);
});

test('a stored entry and a folder around the profile stream like any other', async () => {
  const target = await createProfile('stored');
  const archive = storedZip([
    ['SillyTavern/data/default-user/settings.json', Buffer.from('{"stored":true}')],
    ['SillyTavern/data/default-user/chats/a.jsonl', Buffer.from('hello')],
  ]);
  const stream = target.store.openStream(tailOf(archive), archive.length);
  assert.equal(stream.preview.root, 'SillyTavern/data/default-user/');
  const restoring = target.store.restoreStream(target.profile, stream, { mode: 'replace' });
  await stream.whenReady(5000);
  await upload(stream, archive, 7);
  await restoring;
  assert.equal(await readFile(join(target.dataRoot, 'settings.json'), 'utf8'), '{"stored":true}');
  assert.equal(await readFile(join(target.dataRoot, 'chats', 'a.jsonl'), 'utf8'), 'hello');
});

test('a directory that does not match the archive size, or an unsafe name, is refused before anything starts', async () => {
  const target = await createProfile('refused');
  const archive = storedZip([['settings.json', Buffer.from('{}')]]);
  assert.throws(() => target.store.openStream(tailOf(archive), archive.length + 1), (error: unknown) => error instanceof BackupError && error.code === 'invalid_archive');
  const unsafe = storedZip([['../escape.txt', Buffer.from('no')]]);
  assert.throws(() => target.store.openStream(tailOf(unsafe), unsafe.length), (error: unknown) => error instanceof BackupError && error.code === 'unsafe_archive');
});

test('bytes that do not match what the directory recorded fail the restore', async () => {
  const target = await createProfile('short');
  const archive = storedZip([['settings.json', Buffer.from('{"a":1}')], ['chats/b.jsonl', Buffer.from('b'.repeat(100))]]);
  const stream = target.store.openStream(tailOf(archive), archive.length);
  // Settled as soon as the damage is found, which is before the push that
  // found it has answered; read as a value so that is not an unhandled one.
  const restoring = target.store.restoreStream(target.profile, stream, { mode: 'merge' }).then(() => null, (error: unknown) => error);
  await stream.whenReady(5000);
  await stream.push(0, archive.subarray(0, 40));
  await assert.rejects(() => stream.push(1, archive.subarray(40, 60)).then(() => stream.push(2, Buffer.alloc(archive.length - 60))), BackupError);
  assert.ok(await restoring instanceof BackupError);
});

/** A zip whose entries are stored rather than deflated, built by hand. */
function storedZip(files: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32(data) >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc32(data) >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
