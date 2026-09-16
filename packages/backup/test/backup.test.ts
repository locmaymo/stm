import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { BackupError, BackupStore } from '../src/index.js';

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'stm-backup-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  const dataPath = join(runtimePath, 'data');
  const configPath = join(runtimePath, 'config.yaml');
  await mkdir(join(dataPath, 'chats'), { recursive: true });
  await mkdir(join(dataPath, 'node_modules'), { recursive: true });
  await writeFile(join(dataPath, 'chats', 'こんにちは.json'), '{"message":"keep"}', 'utf8');
  await writeFile(join(dataPath, 'node_modules', 'ignored.txt'), 'ignore', 'utf8');
  await writeFile(configPath, 'listen: false\n', 'utf8');
  await writeFile(join(dataPath, 'secrets.json'), '{"api_key":"secret"}', 'utf8');
  const profile: Profile = {
    id: 'profile-1', name: 'Default', installationId: 'installation-1', runtimePath,
    configPath, dataPath, layout: 'data', active: true, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString(),
  };
  return { root, paths, profile };
}

test('a backup carries the whole user directory, config included', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const manifest = await store.create(fixture.profile);
  assert.equal(manifest.fileCount, 4);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);
  const preview = await store.preview(archive, fixture.profile.layout);
  // Nothing is held back - not credentials, not a dependency tree an
  // extension brought with it.
  assert.deepEqual(preview.files.map((file) => file.name).sort(), ['chats/こんにちは.json', 'config.yaml', 'node_modules/ignored.txt', 'secrets.json']);
  assert.equal(preview.warnings.length, 0);
});

test('an archive that looks nothing like a profile says so in a translatable way', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-backup-odd-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  const dataPath = join(runtimePath, 'data');
  await mkdir(join(dataPath, 'holiday-photos'), { recursive: true });
  await writeFile(join(dataPath, 'holiday-photos', 'beach.txt'), 'not a chat', 'utf8');
  await writeFile(join(runtimePath, 'config.yaml'), 'listen: false\n', 'utf8');
  const profile: Profile = {
    id: 'profile-1', name: 'Default', installationId: 'installation-1', runtimePath,
    configPath: join(runtimePath, 'config.yaml'), dataPath, layout: 'data', active: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activatedAt: new Date().toISOString(),
  };
  const store = new BackupStore({ paths });
  const manifest = await store.create(profile);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);
  const preview = await store.preview(archive, profile.layout);
  // The warning is a code the panel looks up, not a sentence in one language:
  // it is read at the one moment that cannot be undone, and the reader may not
  // have English.
  assert.equal(preview.warnings.length, 1);
  assert.equal(preview.warnings[0]?.code, 'backup.unknownArchive');
  assert.ok((preview.warnings[0]?.message ?? '').length > 0, 'and still says something without a catalogue');
});

test('a replace restores every file the archive holds, credentials included', async () => {
  const fixture = await createFixture();
  const sourceStore = new BackupStore({ paths: fixture.paths });
  const manifest = await sourceStore.create(fixture.profile);
  const archive = await sourceStore.getArchivePath(manifest.id);
  assert.ok(archive);
  const targetRoot = join(fixture.root, 'target-runtime');
  const targetData = join(targetRoot, 'data');
  const targetConfig = join(targetRoot, 'config.yaml');
  await mkdir(targetData, { recursive: true });
  await writeFile(join(targetData, 'old.txt'), 'old', 'utf8');
  const target: Profile = { ...fixture.profile, runtimePath: targetRoot, dataPath: targetData, configPath: targetConfig };
  await sourceStore.restore(target, archive, { mode: 'replace' });
  const targetUserData = join(targetData, 'default-user');
  assert.equal(await readFile(join(targetUserData, 'chats', 'こんにちは.json'), 'utf8'), '{"message":"keep"}');
  await assert.rejects(() => readFile(join(targetUserData, 'old.txt'), 'utf8'));
  assert.equal(await readFile(join(targetUserData, 'secrets.json'), 'utf8'), '{"api_key":"secret"}');
});

test('rejects zip-slip paths before extraction', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const archive = join(fixture.root, 'unsafe.zip');
  await writeStoredZip(archive, '../escape.txt', 'bad');
  await assert.rejects(() => store.preview(archive), (error: unknown) => error instanceof BackupError && error.code === 'unsafe_archive');
});

test('modern user-root restore preserves config when the SillyTavern archive omits it', async () => {
  const fixture = await createFixture();
  const sourceProfile: Profile = { ...fixture.profile, configPath: join(fixture.root, 'missing-config.yaml') };
  const sourceStore = new BackupStore({ paths: fixture.paths });
  const manifest = await sourceStore.create(sourceProfile);
  const archive = await sourceStore.getArchivePath(manifest.id);
  assert.ok(archive);
  const targetRoot = join(fixture.root, 'modern-target');
  const targetData = join(targetRoot, 'data');
  const targetConfig = join(targetRoot, 'config.yaml');
  await mkdir(join(targetData, 'default-user'), { recursive: true });
  await writeFile(targetConfig, 'listen: true\n', 'utf8');
  const target: Profile = { ...fixture.profile, runtimePath: targetRoot, dataPath: targetData, configPath: targetConfig };
  await sourceStore.restore(target, archive, { mode: 'replace' });
  assert.equal(await readFile(join(targetData, 'default-user', 'chats', 'こんにちは.json'), 'utf8'), '{"message":"keep"}');
  assert.equal(await readFile(targetConfig, 'utf8'), 'listen: true\n');
});

test('merge restore keeps untouched files and applies archive entries without a second byte copy', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const manifest = await store.create(fixture.profile);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);
  const targetRoot = join(fixture.root, 'merge-target');
  const targetData = join(targetRoot, 'data');
  const targetUserData = join(targetData, 'default-user');
  await mkdir(join(targetUserData, 'chats'), { recursive: true });
  await writeFile(join(targetUserData, 'chats', 'keep-me.json'), '{"message":"mine"}', 'utf8');
  await writeFile(join(targetUserData, 'chats', 'こんにちは.json'), '{"message":"stale"}', 'utf8');
  const target: Profile = { ...fixture.profile, runtimePath: targetRoot, dataPath: targetData, configPath: join(targetRoot, 'config.yaml') };
  await store.restore(target, archive, { mode: 'merge' });
  assert.equal(await readFile(join(targetUserData, 'chats', 'keep-me.json'), 'utf8'), '{"message":"mine"}');
  assert.equal(await readFile(join(targetUserData, 'chats', 'こんにちは.json'), 'utf8'), '{"message":"keep"}');
  await store.settle();
});

test('restores every entry of a large archive exactly once under parallel extraction', async () => {
  const fixture = await createFixture();
  const chats = join(fixture.profile.dataPath, 'chats');
  const expected = new Map<string, string>();
  for (let index = 0; index < 400; index += 1) {
    const name = `chat-${index}-Ω.jsonl`;
    const body = `{"index":${index},"filler":"${'x'.repeat(index * 7)}"}`;
    expected.set(name, body);
    await writeFile(join(chats, name), body, 'utf8');
  }
  const store = new BackupStore({ paths: fixture.paths });
  const manifest = await store.create(fixture.profile);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);
  const targetRoot = join(fixture.root, 'parallel-target');
  const targetData = join(targetRoot, 'data');
  const target: Profile = { ...fixture.profile, runtimePath: targetRoot, dataPath: targetData, configPath: join(targetRoot, 'config.yaml') };
  await store.restore(target, archive, { mode: 'replace' });
  const restoredChats = join(targetData, 'default-user', 'chats');
  for (const [name, body] of expected) assert.equal(await readFile(join(restoredChats, name), 'utf8'), body);

  // A second restore exercises the clear-and-replace path, and neither run may
  // leave staging or trash behind where SillyTavern would read it as user data.
  await store.restore(target, archive, { mode: 'replace' });
  for (const [name, body] of expected) assert.equal(await readFile(join(restoredChats, name), 'utf8'), body);
  await store.settle();
  assert.deepEqual((await readdir(targetData)).sort(), ['default-user']);
  assert.ok(!(await readdir(join(targetData, 'default-user'))).some((name) => name.startsWith('.stm-')));
});

test('replace writes in place and drops the files the backup does not hold', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const manifest = await store.create(fixture.profile);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);

  const targetRoot = join(fixture.root, 'replace-target');
  const targetData = join(targetRoot, 'data');
  const targetUserData = join(targetData, 'default-user');
  await mkdir(join(targetUserData, 'chats'), { recursive: true });
  await mkdir(join(targetUserData, 'thumbnails'), { recursive: true });
  await writeFile(join(targetUserData, 'chats', 'こんにちは.json'), '{"message":"stale"}', 'utf8');
  await writeFile(join(targetUserData, 'chats', 'gone.json'), '{"message":"not in backup"}', 'utf8');
  await writeFile(join(targetUserData, 'secrets.json'), '{"api_key":"mine"}', 'utf8');
  await writeFile(join(targetUserData, 'thumbnails', 'cached.png'), 'cache', 'utf8');
  const target: Profile = { ...fixture.profile, runtimePath: targetRoot, dataPath: targetData, configPath: join(targetRoot, 'config.yaml') };

  await store.restore(target, archive, { mode: 'replace' });
  await store.settle();

  assert.equal(await readFile(join(targetUserData, 'chats', 'こんにちは.json'), 'utf8'), '{"message":"keep"}');
  await assert.rejects(() => readFile(join(targetUserData, 'chats', 'gone.json'), 'utf8'));
  // A replace is the archive's contents, so its secrets.json wins and the
  // cache the archive never held is gone.
  assert.equal(await readFile(join(targetUserData, 'secrets.json'), 'utf8'), '{"api_key":"secret"}');
  await assert.rejects(() => readFile(join(targetUserData, 'thumbnails', 'cached.png'), 'utf8'));
  // Nothing may be staged beside the user directory any more.
  assert.deepEqual((await readdir(targetData)).sort(), ['default-user']);
});

test('a restore overwrites a read-only file instead of failing the run', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const manifest = await store.create(fixture.profile);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);

  // Git writes its loose objects read-only, and Windows will not open a
  // read-only file for writing - so every restore after the first one that
  // created such a file failed on it.
  const target = join(fixture.profile.dataPath, 'chats', 'こんにちは.json');
  await writeFile(target, '{"message":"stale"}', 'utf8');
  await chmod(target, 0o444);

  await store.restore(fixture.profile, archive, { mode: 'merge' });
  assert.equal(await readFile(target, 'utf8'), '{"message":"keep"}');
});

test('a read-only file does not take the archive handle down with it', async () => {
  const fixture = await createFixture();
  const chats = join(fixture.profile.dataPath, 'chats');
  const expected = new Map<string, string>();
  for (let index = 0; index < 60; index += 1) {
    const name = `chat-${index}.jsonl`;
    // Incompressible and large enough that the read is still in flight when
    // the write fails - which is the order the descriptor is lost in.
    const body = randomBytes(96 * 1024).toString('base64');
    expected.set(name, body);
    await writeFile(join(chats, name), body, 'utf8');
  }
  const store = new BackupStore({ paths: fixture.paths });
  const manifest = await store.create(fixture.profile);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);

  // Every worker should meet an unwritable file early, so a worker that lost
  // its descriptor to the first one would fail on everything it had left.
  for (const name of [...expected.keys()].slice(0, 24)) {
    await writeFile(join(chats, name), '{"message":"stale"}', 'utf8');
    await chmod(join(chats, name), 0o444);
  }

  await store.restore(fixture.profile, archive, { mode: 'merge' });
  for (const [name, body] of expected) assert.equal(await readFile(join(chats, name), 'utf8'), body);
});

test('a file removed while the backup runs is skipped and the archive stays readable', async () => {
  const fixture = await createFixture();
  const chats = join(fixture.profile.dataPath, 'chats');
  for (let index = 0; index < 8; index += 1) await writeFile(join(chats, `chat-${index}.jsonl`), `{"index":${index}}`, 'utf8');
  const store = new BackupStore({ paths: fixture.paths });

  // A legacy runtime shutting down deletes the whole user directory, and a
  // character the operator removes goes the same way: the walk listed a file
  // that is gone by the time the archive reaches it.
  const doomed = ['chat-6.jsonl', 'chat-7.jsonl'].map((name) => join(chats, name));
  const manifest = await store.create(fixture.profile, {
    onProgress: ({ completed }) => { if (completed === 1) for (const path of doomed) rmSync(path, { force: true }); },
  });

  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);
  // A skipped file must leave no trace: the count is what the archive holds and
  // the central directory still describes every byte in it.
  const preview = await store.preview(archive, fixture.profile.layout);
  assert.equal(preview.fileCount, manifest.fileCount);
  assert.equal(preview.fileCount, 10);
  assert.ok(!preview.files.some((file) => file.name.endsWith('chat-7.jsonl')));

  // And the archive has to be restorable, which a header describing bytes that
  // never arrived would not be.
  const targetRoot = join(fixture.root, 'skip-target');
  const target: Profile = { ...fixture.profile, runtimePath: targetRoot, dataPath: join(targetRoot, 'data'), configPath: join(targetRoot, 'config.yaml') };
  await store.restore(target, archive, { mode: 'replace' });
  assert.equal(await readFile(join(targetRoot, 'data', 'default-user', 'chats', 'chat-0.jsonl'), 'utf8'), '{"index":0}');
});

test('a long backup does not accumulate error listeners on its output', async () => {
  const fixture = await createFixture();
  const chats = join(fixture.profile.dataPath, 'chats');
  // Incompressible content, so the writes actually reach backpressure - which
  // is the only path that waited on a drain.
  for (let index = 0; index < 40; index += 1) await writeFile(join(chats, `chat-${index}.jsonl`), randomBytes(128 * 1024).toString('base64'), 'utf8');
  const warnings: string[] = [];
  const record = (warning: Error): void => { warnings.push(warning.name); };
  process.on('warning', record);
  try {
    const store = new BackupStore({ paths: fixture.paths });
    await store.create(fixture.profile);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  } finally {
    process.removeListener('warning', record);
  }
  assert.deepEqual(warnings.filter((name) => name === 'MaxListenersExceededWarning'), []);
});

test('a safety copy reuses an unchanged profile’s newest backup instead of writing another', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const first = await store.createSafetyCopy(fixture.profile, { name: 'Default-prerestore' });
  const reused = await store.createSafetyCopy(fixture.profile, { name: 'Default-prerestore' });
  assert.equal(reused.id, first.id);
  assert.equal((await store.list(fixture.profile.id)).length, 1);

  // Changing the profile has to produce a new copy.
  await writeFile(join(fixture.profile.dataPath, 'chats', 'new.json'), '{"message":"added"}', 'utf8');
  const afterChange = await store.createSafetyCopy(fixture.profile, { name: 'Default-prerestore' });
  assert.notEqual(afterChange.id, first.id);
});

test('a new backup supersedes the manager’s older ones but never an uploaded archive', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const uploaded = join(fixture.root, 'uploaded.zip');
  await writeStoredZip(uploaded, 'chats/imported.json', '{"message":"imported"}');
  const kept = await store.importArchive(fixture.profile, uploaded, 'from-my-laptop.zip');

  const first = await store.create(fixture.profile, { name: 'Default-scheduled' });
  await writeFile(join(fixture.profile.dataPath, 'chats', 'new.json'), '{"message":"added"}', 'utf8');
  const second = await store.create(fixture.profile, { name: 'Default-prerestore' });

  const remaining = await store.list(fixture.profile.id);
  assert.deepEqual(remaining.map((manifest) => manifest.id).sort(), [kept.manifest.id, second.id].sort());
  assert.equal(await store.getArchivePath(first.id), null);
  assert.ok(await store.getArchivePath(kept.manifest.id));
});

test('reserving the operation slot holds off a scheduled backup before the work starts', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  assert.equal(store.isOperationRunning(), false);
  const release = store.reserve();
  assert.equal(store.isOperationRunning(), true);
  release();
  assert.equal(store.isOperationRunning(), false);
  // Releasing twice must not let the count fall below zero and re-open the gap.
  release();
  assert.equal(store.isOperationRunning(), false);
});

test('abandoned upload parts are swept by age while a fresh one is left alone', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const stream = (value: string): AsyncIterable<Uint8Array> => (async function* () { yield Buffer.from(value, 'utf8'); })();
  await store.appendUploadChunk('abandoned-upload-1', 0, stream('half a file'));
  await store.appendUploadChunk('recent-upload-22', 0, stream('still going'));
  const abandoned = join(fixture.paths.tmp, 'upload-abandoned-upload-1.zip.part');
  const recent = join(fixture.paths.tmp, 'upload-recent-upload-22.zip.part');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(abandoned, old, old);
  await utimes(join(fixture.paths.tmp, 'upload-abandoned-upload-1.json'), old, old);

  assert.equal(await store.sweepStaleUploads(24 * 60 * 60 * 1000), 2);
  await assert.rejects(() => readFile(abandoned, 'utf8'));
  assert.equal(await readFile(recent, 'utf8'), 'still going');
});

test('assembles chunked uploads in order without buffering the archive', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const uploadId = 'chunk-upload-1234';
  const stream = (value: string): AsyncIterable<Uint8Array> => (async function* () { yield Buffer.from(value, 'utf8'); })();
  await store.appendUploadChunk(uploadId, 0, stream('hello '));
  await store.appendUploadChunk(uploadId, 1, stream('world'));
  const archive = await store.finishUpload(uploadId, 11);
  assert.equal(await readFile(archive, 'utf8'), 'hello world');
  await store.removeTemporary(archive);
  await assert.rejects(() => store.finishUpload(uploadId), (error: unknown) => error instanceof BackupError && error.code === 'upload_incomplete');
});

async function writeStoredZip(path: string, name: string, content: string): Promise<void> {
  const nameBuffer = Buffer.from(name, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const local = Buffer.alloc(30 + nameBuffer.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26); nameBuffer.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuffer.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuffer.length, 28); nameBuffer.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + data.length, 16);
  await writeFile(path, Buffer.concat([local, data, central, end]));
}

test('archives nothing points at are reclaimed, and the ones in the library are kept', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const kept = await store.create(fixture.profile);

  // A backup killed mid-write leaves its partial, and an import killed between
  // moving the upload in and recording it leaves the whole archive.
  await writeFile(join(fixture.paths.archives, '.aborted-backup.zip.tmp'), 'partial', 'utf8');
  await writeFile(join(fixture.paths.archives, 'f1757ca2-56b3-4c62-998b-1a1d2693d7c5.zip'), 'unreferenced', 'utf8');

  assert.equal(await store.sweepOrphanArchives(), 2);
  assert.deepEqual(await readdir(fixture.paths.archives), [`${kept.id}.zip`]);
  assert.ok(await store.getArchivePath(kept.id));
  // Nothing left to reclaim on the next start.
  assert.equal(await store.sweepOrphanArchives(), 0);
});

test('the local backup schedule is kept with the library and survives a restart', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  assert.equal((await store.getSchedule()).intervalMinutes, 60);
  const created = await store.create(fixture.profile);
  await store.setSchedule({ intervalMinutes: 360 });
  await assert.rejects(() => store.setSchedule({ intervalMinutes: -1 }), (error: unknown) => error instanceof BackupError && error.code === 'invalid_backup_schedule');

  const reopened = new BackupStore({ paths: fixture.paths });
  assert.equal((await reopened.getSchedule()).intervalMinutes, 360);
  // Saving the schedule wrote the library as it was then, backup included.
  assert.deepEqual((await reopened.list()).map((backup) => backup.id), [created.id]);
  // An interval handed over from the old R2 settings never overrides a choice made here.
  await reopened.adoptLegacySchedule(30);
  assert.equal((await reopened.getSchedule()).intervalMinutes, 360);
});

test('an interval from the old R2 settings is taken when none was chosen here', async () => {
  const fixture = await createFixture();
  await new BackupStore({ paths: fixture.paths }).adoptLegacySchedule(30);
  assert.equal((await new BackupStore({ paths: fixture.paths }).getSchedule()).intervalMinutes, 30);
  // One that was out of range is dropped, leaving the default.
  const other = await createFixture();
  await new BackupStore({ paths: other.paths }).adoptLegacySchedule(0);
  assert.equal((await new BackupStore({ paths: other.paths }).getSchedule()).intervalMinutes, 60);
});

test('the local backup schedule can be turned off, and stays off', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  assert.deepEqual(await store.setSchedule({ intervalMinutes: 0 }), { intervalMinutes: 0 });
  const reopened = new BackupStore({ paths: fixture.paths });
  assert.equal((await reopened.getSchedule()).intervalMinutes, 0);
  await reopened.adoptLegacySchedule(30);
  assert.equal((await reopened.getSchedule()).intervalMinutes, 0);
});
