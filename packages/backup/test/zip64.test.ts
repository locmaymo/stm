import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { BackupStore, ZipWriter } from '../src/index.js';

async function createProfile(name: string): Promise<{ root: string; profile: Profile; dataRoot: string; store: BackupStore }> {
  const root = await mkdtemp(join(tmpdir(), `stm-zip64-${name}-`));
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

const FILES: ReadonlyArray<readonly [string, Buffer]> = [
  ['settings.json', Buffer.from('{"zip64":true}')],
  ['chats/Trò chuyện.jsonl', Buffer.from('{"line":1}\n'.repeat(2000))],
  ['backgrounds/big.bin', randomBytes(2 * 1024 * 1024)],
  ['chats/empty.jsonl', Buffer.alloc(0)],
];

/**
 * A zip written the way one past four gigabytes or 65,535 files is, with
 * every size, offset and count in ZIP64 fields, without writing gigabytes.
 */
async function zip64Archive(directory: string, mixed = false): Promise<string> {
  const path = join(directory, 'zip64.zip');
  const writer = new ZipWriter(path, { forceZip64: true });
  for (const [index, [name, body]] of FILES.entries()) {
    // Some entries of known size and some streamed without one, as R2 sends them.
    if (mixed && index % 2 === 0) await writer.addStream(name, Readable.from([body]));
    else await writer.addStream(name, Readable.from([body]), body.length);
  }
  await writer.finish();
  return path;
}

test('a ZIP64 archive is written with its end records and read back whole', async () => {
  const target = await createProfile('read');
  const archive = await readFile(await zip64Archive(target.root));
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(archive.readUInt16LE(eocd + 10), 0xffff);
  assert.equal(archive.readUInt32LE(eocd + 16), 0xffffffff);
  assert.equal(archive.readUInt32LE(eocd - 20), 0x07064b50, 'the locator sits right before the end record');

  const preview = await target.store.preview(join(target.root, 'zip64.zip'));
  assert.equal(preview.fileCount, FILES.length);
  assert.equal(preview.totalBytes, FILES.reduce((sum, [, body]) => sum + body.length, 0));
  assert.equal(preview.recognized, true);
});

test('a ZIP64 archive restores from the library like any other', async () => {
  const target = await createProfile('restore');
  const path = await zip64Archive(target.root, true);
  const { manifest } = await target.store.importArchive(target.profile, path, 'big.zip');
  await target.store.restore(target.profile, (await target.store.getArchivePath(manifest.id))!, { mode: 'replace' });
  for (const [name, body] of FILES) assert.deepEqual(await readFile(join(target.dataRoot, ...name.split('/'))), body, name);
});

test('a ZIP64 archive streams from the end its browser cuts out', async () => {
  const target = await createProfile('stream');
  const archive = await readFile(await zip64Archive(target.root));
  // The browser reads the directory's start from the ZIP64 record.
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const record = Number(archive.readBigUInt64LE(eocd - 20 + 8));
  const directoryOffset = Number(archive.readBigUInt64LE(record + 48));
  const stream = await target.store.openStream(archive.subarray(directoryOffset), archive.length);
  assert.equal(stream.preview.fileCount, FILES.length);
  const restoring = target.store.restoreStream(target.profile, stream, { mode: 'replace' });
  await stream.whenReady(5000);
  for (let index = 0, offset = 0; offset < archive.length; index += 1, offset += 64 * 1024) {
    if ((await stream.push(index, archive.subarray(offset, offset + 64 * 1024))).done) break;
  }
  await restoring;
  for (const [name, body] of FILES) assert.deepEqual(await readFile(join(target.dataRoot, ...name.split('/'))), body, name);
});

test('a backup that fits the old format is still written in it', async () => {
  const source = await createProfile('plain');
  await writeFile(join(source.dataRoot, 'settings.json'), '{}', 'utf8');
  const manifest = await source.store.create(source.profile);
  const archive = await readFile((await source.store.getArchivePath(manifest.id))!);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(archive.readUInt32LE(eocd - 20), 0x07064b50);
  assert.equal(archive.readUInt16LE(eocd + 10), 1);
});
