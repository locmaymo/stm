import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Installation, Profile } from '../../contracts/src/index.js';
import { ConfigStore } from '../src/index.js';

async function fixture(accounts = true): Promise<{ store: ConfigStore; profile: Profile; installation: Installation; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-config-'));
  const runtimePath = join(root, 'runtime');
  const configPath = join(root, 'profile', 'config.yaml');
  await mkdir(runtimePath, { recursive: true });
  await mkdir(join(root, 'profile'), { recursive: true });
  // Versions from 1.12 on carry the accounts implementation; older ones do not,
  // and that file is what the store reads to tell them apart.
  if (accounts) {
    await mkdir(join(runtimePath, 'src'), { recursive: true });
    await writeFile(join(runtimePath, 'src', 'users.js'), 'export const users = true;\n', 'utf8');
  }
  await writeFile(configPath, '# keep this comment\nlisten: false\nport: 8000\nbasicAuthMode: false\nbasicAuthUser:\n  username: user\n  password: old-secret\nssl:\n  enabled: false\n', 'utf8');
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.18.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const profile: Profile = { id: 'profile-1', name: 'Default', installationId: installation.id, runtimePath, configPath, dataPath: join(root, 'profile', 'data'), layout: 'data', active: true, createdAt: now, updatedAt: now, activatedAt: now };
  return { store: new ConfigStore(), profile, installation, configPath };
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

test('common settings update atomically while enabling account mode', async () => {
  const { store, profile, installation, configPath } = await fixture();
  const document = await store.update(profile, installation, { settings: { listen: true } });
  assert.equal(document.settings.listen, true);
  assert.equal(document.settings.enableUserAccounts, true);
  const raw = await readFile(configPath, 'utf8');
  assert.match(raw, /# keep this comment/u);
  assert.match(raw, /listen: true/u);
  assert.match(raw, /basicAuthMode: false/u);
  assert.match(raw, /username: user/u);
  assert.equal((parseYaml(raw) as { basicAuthUser: { password: string } }).basicAuthUser.password, 'old-secret');
  assert.equal(await readFile(`${configPath}.bak`, 'utf8').then((value) => value.includes('listen: false')), true);
});

test('raw YAML saves disable Basic Auth and fill missing defaults without removing keys', async () => {
  const { store, profile, installation, configPath } = await fixture();
  const document = await store.update(profile, installation, { rawYaml: 'listen: false\nport: 8000\nbasicAuthMode: true\n' });
  assert.equal(document.settings.enableUserAccounts, true);
  const raw = await readFile(configPath, 'utf8');
  assert.match(raw, /basicAuthMode: false/u);
  assert.match(raw, /basicAuthUser:\n  username: user\n  password: password/u);
  assert.equal(document.rawYaml, raw);
  await store.update(profile, installation, { settings: { enableCorsProxy: true } });
  assert.match(await readFile(configPath, 'utf8'), /basicAuthUser:\n  username: user\n  password: password/u);
});

test('saving masked raw YAML keeps the stored Basic Auth password while disabling the mode', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: false\nport: 8000\nbasicAuthMode: true\nbasicAuthUser:\n  username: admin\n  password: old-secret\n', 'utf8');
  const document = await store.read(profile, installation);
  assert.equal(document.rawYaml.includes('old-secret'), false);
  await store.update(profile, installation, { rawYaml: document.rawYaml });
  const raw = await readFile(configPath, 'utf8');
  assert.match(raw, /basicAuthMode: false/u);
  assert.match(raw, /username: admin/u);
  assert.equal((parseYaml(raw) as { basicAuthUser: { password: string } }).basicAuthUser.password, 'old-secret');
  assert.equal(raw.includes('********'), false);
});

test('LAN listen switches to SillyTavern account mode instead of basic auth', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: false\nport: 8000\nwhitelistMode: true\nbasicAuthMode: false\n', 'utf8');
  const document = await store.update(profile, installation, { settings: { listen: true } });
  assert.equal(document.settings.listen, true);
  assert.equal(document.settings.whitelistMode, false);
  assert.equal(document.settings.enableUserAccounts, true);
  assert.match(document.rawYaml, /basicAuthUser:\n  username: user\n  password: password/u);
});

test('disabled Basic Auth defaults do not reset a configured LAN on every restart', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: true\nport: 8000\nenableUserAccounts: true\nbasicAuthMode: false\nbasicAuthUser:\n  username: user\n  password: password\n', 'utf8');
  assert.equal(await store.needsAccountMigration(profile, installation), false);
});

test('a version without user accounts is driven through Basic Auth instead', async () => {
  const { store, profile, installation, configPath } = await fixture(false);
  const document = await store.read(profile, installation);
  assert.equal(document.accessMode, 'basicAuth');
  // Nothing to migrate to, so the config is left alone on every start.
  assert.equal(await store.needsAccountMigration(profile, installation), false);

  const saved = await store.setBasicAuthPassword(profile, installation, 'a-real-secret');
  assert.equal(saved.settings.basicAuthMode, true);
  assert.equal(saved.rawYaml.includes('a-real-secret'), false, 'the saved password is masked in the document sent to the panel');
  const raw = await readFile(configPath, 'utf8');
  assert.equal(parseYaml(raw).basicAuthUser.password, 'a-real-secret');
  assert.equal(parseYaml(raw).basicAuthMode, true);

  const basic = await store.readBasicAuth(profile, installation);
  assert.deepEqual(basic, { username: 'user', passwordConfigured: true, enabled: true });
});

test('an untouched Basic Auth password does not count as protection', async () => {
  const { store, profile, installation, configPath } = await fixture(false);
  await writeFile(configPath, 'listen: false\nport: 8000\nbasicAuthMode: true\nbasicAuthUser:\n  username: user\n  password: password\n', 'utf8');
  assert.deepEqual(await store.readBasicAuth(profile, installation), { username: 'user', passwordConfigured: false, enabled: true });
});

test('a version without accounts keeps Basic Auth through an unrelated settings save', async () => {
  const { store, profile, installation, configPath } = await fixture(false);
  await store.setBasicAuthPassword(profile, installation, 'a-real-secret');
  await store.update(profile, installation, { settings: { listen: true } });
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.basicAuthMode, true, 'saving other settings must not switch off the only password this version has');
  assert.equal(raw.basicAuthUser.password, 'a-real-secret');
  assert.equal(raw.enableUserAccounts, undefined, 'a key this version does not understand is not invented for it');
});

test('downgrading to a version without accounts leaves a config it can start from', async () => {
  // What the panel writes for a version with user accounts: the network is
  // open because an account password guards it, so whitelisting is off. On
  // 1.10 that exact combination makes the server print "unsecurely open to
  // the public" and exit 1 before it ever listens.
  const { store, profile, installation, configPath } = await fixture(false);
  await writeFile(configPath, 'listen: true\nport: 8000\nwhitelistMode: false\nbasicAuthMode: false\nenableUserAccounts: true\nbasicAuthUser:\n  username: user\n  password: password\n', 'utf8');

  assert.equal(await store.reconcileForRuntime(profile, installation), 'basicAuth');
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.listen, false, 'with no password to open the port with, it is closed rather than left unstartable');
  assert.equal(raw.basicAuthMode, false);
  // Nothing left to fix, so a second start rewrites nothing.
  assert.equal(await store.reconcileForRuntime(profile, installation), null);
});

test('a legacy version with a password keeps the network open instead of losing it', async () => {
  const { store, profile, installation, configPath } = await fixture(false);
  await writeFile(configPath, 'listen: true\nport: 8000\nwhitelistMode: false\nbasicAuthMode: false\nbasicAuthUser:\n  username: user\n  password: a-real-secret\n', 'utf8');

  assert.equal(await store.reconcileForRuntime(profile, installation), 'basicAuth');
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.listen, true, 'there is a password, so the port it guards stays open');
  assert.equal(raw.basicAuthMode, true);
});

test('a legacy runtime is not left opening its own browser window', async () => {
  const { store, profile, installation, configPath } = await fixture(false);
  await writeFile(configPath, 'listen: false\nport: 8000\nautorun: true\nbrowserLaunch:\n  enabled: true\n', 'utf8');
  assert.equal(await store.reconcileForRuntime(profile, installation), 'basicAuth');
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.autorun, false);
  assert.equal(raw.browserLaunch.enabled, false);
});

test('enabling the network on a legacy version turns on the only guard it has', async () => {
  const { store, profile, installation, configPath } = await fixture(false);
  await store.setBasicAuthPassword(profile, installation, 'a-real-secret');
  await store.update(profile, installation, { settings: { listen: true } });
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.listen, true);
  assert.equal(raw.basicAuthMode, true, 'otherwise the runtime refuses to start at all');
});

test('a version with accounts still migrates towards accounts', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: true\nport: 8000\nbasicAuthMode: true\nbasicAuthUser:\n  username: user\n  password: a-real-secret\n', 'utf8');
  assert.equal(await store.reconcileForRuntime(profile, installation), 'accounts');
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.enableUserAccounts, true);
  assert.equal(raw.basicAuthMode, false);
  assert.equal(raw.listen, false, 'the new account has no password yet, so the network waits for one');
  assert.equal(await store.reconcileForRuntime(profile, installation), null);
});
