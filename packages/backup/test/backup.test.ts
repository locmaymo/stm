import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('creates a SillyTavern-compatible streaming ZIP with safe defaults', async () => {
  const fixture = await createFixture();
  const store = new BackupStore({ paths: fixture.paths });
  const manifest = await store.create(fixture.profile);
  assert.equal(manifest.includesSecrets, false);
  assert.equal(manifest.fileCount, 2);
  const archive = await store.getArchivePath(manifest.id);
  assert.ok(archive);
  const preview = await store.preview(archive, fixture.profile.layout);
  assert.deepEqual(preview.files.map((file) => file.name).sort(), ['chats/こんにちは.json', 'config.yaml']);
  assert.equal(preview.includesSecrets, false);
  assert.equal(preview.warnings.length, 0);
});

test('restore creates merge/replace behavior and requires explicit secrets confirmation', async () => {
  const fixture = await createFixture();
  const sourceStore = new BackupStore({ paths: fixture.paths });
  const manifest = await sourceStore.create(fixture.profile, { includeSecrets: true });
  const archive = await sourceStore.getArchivePath(manifest.id);
  assert.ok(archive);
  const targetRoot = join(fixture.root, 'target-runtime');
  const targetData = join(targetRoot, 'data');
  const targetConfig = join(targetRoot, 'config.yaml');
  await mkdir(targetData, { recursive: true });
  await writeFile(join(targetData, 'old.txt'), 'old', 'utf8');
  const target: Profile = { ...fixture.profile, runtimePath: targetRoot, dataPath: targetData, configPath: targetConfig };
  await assert.rejects(() => sourceStore.restore(target, archive, { mode: 'merge' }), (error: unknown) => error instanceof BackupError && error.code === 'secrets_confirmation_required');
  await sourceStore.restore(target, archive, { mode: 'replace', allowSecrets: true });
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
