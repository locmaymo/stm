import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Installation, Profile } from '../../contracts/src/index.js';
import { ConfigError, ConfigStore } from '../src/index.js';

async function fixture(): Promise<{ store: ConfigStore; profile: Profile; installation: Installation; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-config-'));
  const runtimePath = join(root, 'runtime');
  const configPath = join(root, 'profile', 'config.yaml');
  await mkdir(runtimePath, { recursive: true });
  await mkdir(join(root, 'profile'), { recursive: true });
  await writeFile(configPath, '# keep this comment\nlisten: false\nport: 8000\nbasicAuthMode: false\nbasicAuthUser:\n  username: user\n  password: old-secret\nssl:\n  enabled: false\n', 'utf8');
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.18.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const profile: Profile = { id: 'profile-1', name: 'Default', installationId: installation.id, runtimePath, configPath, dataPath: join(root, 'profile', 'data'), layout: 'data', active: true, createdAt: now, updatedAt: now, activatedAt: now };
  return { store: new ConfigStore({ logger: () => undefined }), profile, installation, configPath };
}

test('config document retains Basic Auth keys and masks a custom password', async () => {
  const { store, profile, installation } = await fixture();
  const document = await store.read(profile, installation);
  assert.equal(document.runtimeRef, '1.18.0');
  assert.equal(document.settings.listen, false);
  assert.equal(document.settings.enableUserAccounts, false);
  assert.match(document.rawYaml, /basicAuthMode: false/u);
  assert.match(document.rawYaml, /username: user/u);
  assert.match(document.rawYaml, /password: ['"]?\*{8}['"]?/u);
  assert.equal(document.rawYaml.includes('old-secret'), false);
});

test('settings update atomically without disturbing comments or unknown keys', async () => {
  const { store, profile, installation, configPath } = await fixture();
  const document = await store.update(profile, installation, { settings: { enableCorsProxy: true } });
  assert.equal(document.settings.enableCorsProxy, true);
  const raw = await readFile(configPath, 'utf8');
  assert.match(raw, /# keep this comment/u);
  assert.match(raw, /enableCorsProxy: true/u);
  assert.match(raw, /username: user/u);
  assert.equal((parseYaml(raw) as { basicAuthUser: { password: string } }).basicAuthUser.password, 'old-secret');
  assert.equal(await readFile(`${configPath}.bak`, 'utf8').then((value) => value.includes('# keep this comment')), true);
});

test('saving masked raw YAML keeps the stored Basic Auth password', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: false\nport: 8000\nbasicAuthMode: false\nbasicAuthUser:\n  username: admin\n  password: old-secret\n', 'utf8');
  const document = await store.read(profile, installation);
  assert.equal(document.rawYaml.includes('old-secret'), false);
  await store.update(profile, installation, { rawYaml: document.rawYaml });
  const raw = await readFile(configPath, 'utf8');
  assert.match(raw, /username: admin/u);
  assert.equal((parseYaml(raw) as { basicAuthUser: { password: string } }).basicAuthUser.password, 'old-secret');
  assert.equal(raw.includes('********'), false);
});

test('an edited YAML document cannot open SillyTavern to the network itself', async () => {
  // Everything reaches SillyTavern through the access gateway, which asks for
  // a password. A config that binds SillyTavern to every interface, or turns
  // on one of its own half-usable protections, would be a way around that.
  const { store, profile, installation, configPath } = await fixture();
  const document = await store.update(profile, installation, {
    rawYaml: 'listen: true\nport: 8000\nwhitelistMode: false\nbasicAuthMode: true\nenableUserAccounts: true\n',
  });
  assert.equal(document.settings.listen, false);
  assert.equal(document.settings.whitelistMode, true);
  assert.equal(document.settings.basicAuthMode, false);
  assert.equal(document.settings.enableUserAccounts, false);
  assert.equal(document.rawYaml, await readFile(configPath, 'utf8'));
});

test('a config written for a newer version is made startable for an older one', async () => {
  // SillyTavern before 1.12 exits with code 1 when listen is on and neither
  // whitelisting nor Basic Auth is, which is exactly what a config written for
  // an accounts-based version looks like. Switching down to it used to look
  // like the version being broken.
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: true\nport: 8000\nwhitelistMode: false\nenableUserAccounts: true\n', 'utf8');

  assert.equal(await store.applyManagedDefaults(profile, installation), true);
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.listen, false);
  assert.equal(raw.whitelistMode, true);
  assert.equal(raw.enableUserAccounts, false);
  // Already right, so a second start writes nothing at all.
  assert.equal(await store.applyManagedDefaults(profile, installation), false);
});

test('a runtime is not left opening its own browser window', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: false\nport: 8000\nautorun: true\nbrowserLaunch:\n  enabled: true\n', 'utf8');
  assert.equal(await store.applyManagedDefaults(profile, installation), true);
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.autorun, false);
  assert.equal(raw.browserLaunch.enabled, false);
});

test('keys a version does not understand are not invented for it', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: false\nport: 8000\n', 'utf8');
  assert.equal(await store.applyManagedDefaults(profile, installation), false);
  await store.update(profile, installation, { settings: { enableCorsProxy: true } });
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.enableUserAccounts, undefined);
  assert.equal(raw.basicAuthMode, undefined);
  assert.equal(raw.whitelistMode, undefined, 'an absent key already holds its default');
});

test('the managed port cannot be moved out from under the manager', async () => {
  const { store, profile, installation } = await fixture();
  await assert.rejects(
    store.update(profile, installation, { rawYaml: 'listen: false\nport: 9000\n' }),
    (error: unknown) => error instanceof ConfigError && error.code === 'invalid_config',
  );
});
