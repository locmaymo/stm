import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import { ProfileStore, ProfileError } from '../src/index.js';

test('creates a data profile without moving runtime data and persists active selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-data-'));
  const runtimePath = join(root, 'runtime');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Main', installationId: 'install-1', runtimePath }, true);
  assert.equal(profile.layout, 'data');
  assert.equal(profile.active, true);
  assert.equal(await stat(profile.dataPath).then((details) => details.isDirectory()), true);
  const reloaded = new ProfileStore({ paths });
  assert.equal((await reloaded.getActive())?.id, profile.id);
  const persisted = JSON.parse(await readFile(join(paths.state, 'profiles.json'), 'utf8')) as { profiles: Array<{ dataPath: string }> };
  assert.equal(persisted.profiles[0]?.dataPath, profile.dataPath);
});

test('copies legacy public layout into the canonical data profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-public-'));
  const runtimePath = join(root, 'runtime');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  await mkdir(runtimePath, { recursive: true });
  await mkdir(join(runtimePath, 'public'), { recursive: true });
  await writeFile(join(runtimePath, 'public', 'chat.json'), '{}', 'utf8');
  const profile = await store.ensureDefault({ installationId: 'install-1', runtimePath });
  assert.equal(profile.layout, 'data');
  assert.equal(profile.legacyLayout, 'public');
  assert.equal(profile.dataPath.endsWith(join('data')), true);
  assert.equal(await readFile(join(profile.dataPath, 'default-user', 'chat.json'), 'utf8'), '{}');
  assert.equal(await readFile(join(runtimePath, 'public', 'chat.json'), 'utf8'), '{}');
});

test('activation creates a safety snapshot before switching profile data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-snapshot-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const first = await store.create({ name: 'First', installationId: 'install-1', runtimePath: join(root, 'runtime') }, true);
  await writeFile(join(first.dataPath, 'chat.json'), '{"hello":"world"}', 'utf8');
  const second = await store.create({ name: 'Second', installationId: 'install-1', runtimePath: join(root, 'runtime') });
  const snapshot = await store.createSafetySnapshot(first);
  assert.equal(snapshot.profileId, first.id);
  assert.equal(await readFile(join(snapshot.path, 'data', 'chat.json'), 'utf8'), '{"hello":"world"}');
  await store.activate(second.id);
  assert.equal((await store.getActive())?.id, second.id);
});

test('duplicate profile names are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-name-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  await store.create({ name: 'Main', installationId: 'install-1', runtimePath: join(root, 'runtime') });
  await assert.rejects(() => store.create({ name: ' main ', installationId: 'install-1', runtimePath: join(root, 'runtime') }), (error: unknown) => error instanceof ProfileError && error.code === 'profile_name_taken');
});

test('rebinding a data profile to a new installation preserves its data root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-rebind-data-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Main', installationId: 'install-old', runtimePath: join(root, 'old-runtime') }, true);
  await writeFile(join(profile.dataPath, 'chat.json'), '{"version":1}', 'utf8');
  const rebound = await store.rebind(profile.id, 'install-new', join(root, 'new-runtime'));
  assert.equal(rebound.installationId, 'install-new');
  assert.equal(rebound.dataPath, profile.dataPath);
  assert.equal(await readFile(join(rebound.dataPath, 'chat.json'), 'utf8'), '{"version":1}');
});

test('rebinding a legacy public profile migrates data and config to the canonical root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-rebind-public-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const oldRuntime = join(root, 'old-runtime');
  const newRuntime = join(root, 'new-runtime');
  const store = new ProfileStore({ paths });
  await mkdir(join(oldRuntime, 'public'), { recursive: true });
  await writeFile(join(oldRuntime, 'public', 'chat.json'), '{"version":1}', 'utf8');
  await writeFile(join(oldRuntime, 'config.yaml'), 'listen: false\n', 'utf8');
  const profile = await store.create({ name: 'Legacy', installationId: 'install-old', runtimePath: oldRuntime, layout: 'public' }, true);
  const rebound = await store.rebind(profile.id, 'install-new', newRuntime);
  assert.equal(rebound.layout, 'data');
  assert.equal(rebound.legacyLayout, 'public');
  assert.equal(await readFile(join(rebound.dataPath, 'default-user', 'chat.json'), 'utf8'), '{"version":1}');
  assert.equal(await readFile(rebound.configPath, 'utf8'), 'listen: false\n');
});

test('bridges canonical data to an older runtime that only uses public/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-legacy-bridge-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Default', installationId: 'install-1', runtimePath }, true);
  await mkdir(join(profile.dataPath, 'default-user'), { recursive: true });
  await writeFile(join(profile.dataPath, 'default-user', 'chat.json'), '{"version":2}', 'utf8');
  await writeFile(join(runtimePath, 'server.js'), "console.log('legacy');", 'utf8');
  await mkdir(join(runtimePath, 'public'), { recursive: true });
  await writeFile(join(runtimePath, 'public', 'index.html'), '<!doctype html>', 'utf8');
  await writeFile(join(profile.dataPath, 'default-user', 'secrets.json'), '{"api_key":"keep"}', 'utf8');
  assert.equal(await store.prepareForRuntime(profile, runtimePath), 'public');
  assert.equal(await readFile(join(runtimePath, 'public', 'index.html'), 'utf8'), '<!doctype html>');
  assert.equal(await readFile(join(runtimePath, 'secrets.json'), 'utf8'), '{"api_key":"keep"}');
  assert.equal(await readFile(join(runtimePath, 'public', 'chat.json'), 'utf8'), '{"version":2}');
  await writeFile(join(runtimePath, 'public', 'chat.json'), '{"version":3}', 'utf8');
  await store.persistFromRuntime(profile, runtimePath, 'public');
  assert.equal(await readFile(join(profile.dataPath, 'default-user', 'chat.json'), 'utf8'), '{"version":3}');
});

test('reuses identical safety snapshots and retains only three changed copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-snapshot-retention-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Default', installationId: 'install-1', runtimePath: join(root, 'runtime') }, true);
  const chat = join(profile.dataPath, 'default-user', 'chat.json');
  await mkdir(join(profile.dataPath, 'default-user'), { recursive: true });
  await writeFile(chat, '{"version":0}', 'utf8');
  const first = await store.createSafetySnapshot(profile);
  const duplicate = await store.createSafetySnapshot(profile);
  assert.equal(duplicate.path, first.path);
  for (let version = 1; version <= 4; version += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3));
    await writeFile(chat, `{"version":${version}}`, 'utf8');
    await store.createSafetySnapshot(profile);
  }
  const snapshots = (await readdir(join(paths.profiles, '.snapshots'))).filter((name) => name.startsWith(`profile-${profile.id}-`));
  assert.equal(snapshots.length, 3);
});
