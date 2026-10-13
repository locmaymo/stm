import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskSecret, parseSecrets, readConnections, secretKeyForApi, selectProxyOnDisk, SettingsEditError, shownAddress } from '../src/connections.js';

async function userRoot(files: { secrets?: string; settings?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stm-connections-'));
  if (files.secrets !== undefined) await writeFile(join(root, 'secrets.json'), files.secrets, 'utf8');
  if (files.settings !== undefined) await writeFile(join(root, 'settings.json'), files.settings, 'utf8');
  return root;
}

const OPENROUTER_MAIN = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const OPENROUTER_SPARE = 'sk-or-v1-fedcba9876543210fedcba9876543210';

/** What SillyTavern 1.19.0 writes: a list per key name, and the migration mark. */
const SECRETS = JSON.stringify({
  _migrated: [],
  api_key_openrouter: [
    { id: 'key-main', value: OPENROUTER_MAIN, label: 'chính', active: true },
    { id: 'key-spare', value: OPENROUTER_SPARE, label: 'dự phòng', active: false },
  ],
  api_key_claude: [{ id: 'key-claude', value: 'short-key', label: 'Claude', active: true }],
  libre_url: [{ id: 'url-1', value: 'http://127.0.0.1:5000', label: 'libre_url', active: true }],
  api_key_custom: 'not a list, so not something SillyTavern wrote',
}, null, 4);

const SETTINGS = JSON.stringify({
  proxies: [
    { name: 'None', url: '', password: '' },
    { name: 'Home proxy', url: 'https://user:pass@proxy.example/v1/?token=abc', password: 'pr0xy-pa55' },
    { name: 'Open proxy', url: 'http://10.0.0.2:5000/', password: '' },
    { name: 'Broken', url: 'not an address', password: '' },
  ],
  selected_proxy: { name: 'Home proxy', url: 'https://proxy.example/v1', password: 'pr0xy-pa55' },
  oai_settings: { chat_completion_source: 'openrouter', custom_url: '' },
  extension_settings: {
    connectionManager: {
      selectedProfile: 'p-or',
      profiles: [
        { id: 'p-or', mode: 'cc', name: 'OpenRouter main', api: 'openrouter', model: 'deepseek/deepseek-chat', 'secret-id': 'key-main', proxy: 'None', preset: 'Default' },
        { id: 'p-proxy', mode: 'cc', name: 'Through the proxy', api: 'oai', model: 'gpt-4o', proxy: 'Home proxy' },
        { id: 'p-gone', mode: 'cc', name: 'Deleted key', api: 'claude', 'secret-id': 'key-that-was-deleted' },
        { id: 'p-local', mode: 'tc', name: 'Local', api: 'koboldcpp', 'api-url': 'http://127.0.0.1:5001' },
        { mode: 'cc', name: 'No id, so not a profile' },
      ],
    },
  },
}, null, 4);

test('keys are listed masked, with the profiles that name them', async () => {
  const overview = await readConnections(await userRoot({ secrets: SECRETS, settings: SETTINGS }));
  assert.equal(overview.profile, true);
  assert.equal(overview.legacySecrets, false);
  assert.deepEqual(overview.unreadable, []);
  assert.deepEqual(overview.keys.map((key) => [key.secretKey, key.provider, key.id, key.label, key.masked, key.active, key.profiles]), [
    ['api_key_openrouter', 'openrouter', 'key-main', 'chính', 'sk-o…cdef', true, ['p-or']],
    ['api_key_openrouter', 'openrouter', 'key-spare', 'dự phòng', 'sk-o…3210', false, []],
    ['api_key_claude', 'claude', 'key-claude', 'Claude', '••••••••', true, []],
  ]);
  // No value, masked or whole, leaves any other way.
  const sent = JSON.stringify(overview);
  for (const value of [OPENROUTER_MAIN, OPENROUTER_SPARE, 'short-key', 'pr0xy-pa55', 'pass@', 'token=abc']) assert.equal(sent.includes(value), false, value);
});

test('proxies are listed without passwords, and profiles say what they point at', async () => {
  const overview = await readConnections(await userRoot({ secrets: SECRETS, settings: SETTINGS }));
  assert.deepEqual(overview.proxies, [
    { name: 'Home proxy', url: 'https://proxy.example/v1', hasPassword: true, selected: true, profiles: ['p-proxy'] },
    { name: 'Open proxy', url: 'http://10.0.0.2:5000', hasPassword: false, selected: false, profiles: [] },
    { name: 'Broken', url: null, hasPassword: false, selected: false, profiles: [] },
  ]);
  assert.deepEqual(overview.profiles.map((profile) => [profile.id, profile.mode, profile.api, profile.proxy, profile.secretId, profile.secretLabel, profile.secretKey, profile.selected]), [
    ['p-or', 'cc', 'openrouter', null, 'key-main', 'chính', 'api_key_openrouter', true],
    ['p-proxy', 'cc', 'oai', 'Home proxy', null, null, 'api_key_openai', false],
    ['p-gone', 'cc', 'claude', null, 'key-that-was-deleted', null, 'api_key_claude', false],
    ['p-local', 'tc', 'koboldcpp', null, null, null, 'api_key_koboldcpp', false],
  ]);
  assert.equal(overview.profiles.find((profile) => profile.id === 'p-local')?.apiUrl, 'http://127.0.0.1:5001');
});

test('a secrets file from before 1.13.1 lists one key per provider, with no id', async () => {
  const overview = await readConnections(await userRoot({ secrets: JSON.stringify({ api_key_openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz', api_key_novel: '', libre_url: 'http://127.0.0.1:5000' }) }));
  assert.equal(overview.legacySecrets, true);
  assert.deepEqual(overview.keys.map((key) => [key.secretKey, key.id, key.label, key.masked, key.active]), [
    ['api_key_openai', null, 'api_key_openai', 'sk-p…wxyz', true],
  ]);
  assert.deepEqual(overview.proxies, []);
  assert.deepEqual(overview.profiles, []);
});

test('empty, missing and broken files are told apart', async () => {
  const empty = await readConnections(await userRoot({ secrets: '', settings: '{}' }));
  assert.deepEqual([empty.keys, empty.proxies, empty.profiles, empty.unreadable, empty.legacySecrets], [[], [], [], [], false]);
  const emptyObject = await readConnections(await userRoot({ secrets: '{}' }));
  assert.deepEqual([emptyObject.keys, emptyObject.legacySecrets], [[], false]);
  const missing = await readConnections(await userRoot({}));
  assert.deepEqual([missing.profile, missing.keys, missing.unreadable], [true, [], []]);
  const broken = await readConnections(await userRoot({ secrets: '{"api_key_openai": [', settings: 'not json' }));
  assert.deepEqual(broken.unreadable, ['secrets', 'settings']);
  const bom = await readConnections(await userRoot({ secrets: `\uFEFF${SECRETS}` }));
  assert.equal(bom.keys.length, 3);
  const none = await readConnections(null);
  assert.deepEqual([none.profile, none.keys], [false, []]);
});

test('masking, addresses and secret names', () => {
  assert.equal(maskSecret('0123456789abcde'), '••••••••');
  assert.equal(maskSecret('  0123456789abcdef  '), '0123…cdef');
  assert.equal(shownAddress('https://u:p@proxy.example:8443/api/v1/?key=1#x'), 'https://proxy.example:8443/api/v1');
  assert.equal(shownAddress('ftp://proxy.example'), null);
  assert.equal(shownAddress(''), null);
  assert.equal(secretKeyForApi('oai'), 'api_key_openai');
  assert.equal(secretKeyForApi('google'), 'api_key_makersuite');
  assert.equal(secretKeyForApi('openrouter-text'), 'api_key_openrouter');
  assert.equal(secretKeyForApi('mistralai'), 'api_key_mistralai');
  assert.deepEqual(parseSecrets(['not', 'an', 'object']), { secrets: [], legacy: false });
});

test('a proxy is chosen on disk by touching only what choosing it in the page touches', async () => {
  const settings = {
    power_user: { theme: 'Dark Lite', custom_css: '.mes { color: red; }' },
    proxies: [{ name: 'None', url: '', password: '' }, { name: 'Home', url: 'https://proxy.example/v1', password: 'pw' }],
    selected_proxy: { name: 'None', url: '', password: '' },
    oai_settings: { reverse_proxy: '', proxy_password: '', temp_openai: 1.1, custom_url: 'http://127.0.0.1:5000/v1' },
    extension_settings: { connectionManager: { selectedProfile: null, profiles: [] } },
  };
  const written = JSON.stringify(settings, null, 4);
  const root = await userRoot({ settings: written });
  await selectProxyOnDisk(root, 'Home');
  const after = await readFile(join(root, 'settings.json'), 'utf8');
  // The same file, with those three values changed and nothing else.
  assert.equal(after, JSON.stringify({ ...settings, selected_proxy: { name: 'Home', url: 'https://proxy.example/v1', password: 'pw' }, oai_settings: { ...settings.oai_settings, reverse_proxy: 'https://proxy.example/v1', proxy_password: 'pw' } }, null, 4));
  assert.equal((await readConnections(root)).proxies.find((proxy) => proxy.name === 'Home')?.selected, true);
  await selectProxyOnDisk(root, 'None');
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), written);
  await assert.rejects(selectProxyOnDisk(root, 'Gone'), (error: unknown) => error instanceof SettingsEditError && error.code === 'proxy_missing');
});

test('a settings file SillyTavern did not write is left alone', async () => {
  const handEdited = JSON.stringify({ proxies: [{ name: 'Home', url: 'https://proxy.example', password: '' }] }, null, 2);
  const root = await userRoot({ settings: handEdited });
  await assert.rejects(selectProxyOnDisk(root, 'Home'), (error: unknown) => error instanceof SettingsEditError && error.code === 'settings_not_round_trip');
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), handEdited);
  await assert.rejects(selectProxyOnDisk(await userRoot({}), 'Home'), (error: unknown) => error instanceof SettingsEditError && error.code === 'settings_missing');
});
