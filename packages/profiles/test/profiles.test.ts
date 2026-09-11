import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

test('detects legacy public layout without converting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-public-'));
  const runtimePath = join(root, 'runtime');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  await mkdir(runtimePath, { recursive: true });
  await mkdir(join(runtimePath, 'public'), { recursive: true });
  await writeFile(join(runtimePath, 'public', 'chat.json'), '{}', 'utf8');
  const profile = await store.ensureDefault({ installationId: 'install-1', runtimePath });
  assert.equal(profile.layout, 'public');
  assert.equal(profile.dataPath, join(runtimePath, 'public'));
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
