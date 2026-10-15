import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigSettings } from '../../../packages/contracts/src/index.js';
import { changedSettings, yamlProblem } from '../src/config-settings.js';

const SAVED: ConfigSettings = {
  listen: false,
  listenAddress: { ipv4: '0.0.0.0', ipv6: '[::]' },
  whitelistMode: true,
  port: 8000,
  enableUserAccounts: false,
  basicAuthMode: false,
  sslEnabled: false,
  enableCorsProxy: false,
  disableCsrfProtection: false,
  lazyLoadCharacters: false,
  useDiskCache: true,
  memoryCacheCapacity: '100mb',
  requestCompression: false,
  extensions: true,
  extensionAutoUpdate: true,
  allowKeysExposure: false,
  chatBackups: true,
  chatBackupCount: 50,
};

test('only what the switches say differently from the file is saved', () => {
  assert.equal(changedSettings({ lazyLoadCharacters: false, useDiskCache: true }, SAVED), null, 'nothing moved, nothing to save');
  assert.deepEqual(changedSettings({ lazyLoadCharacters: true, useDiskCache: true, chatBackupCount: 50 }, SAVED), { lazyLoadCharacters: true });
  assert.deepEqual(changedSettings({ memoryCacheCapacity: '0', chatBackupCount: 10 }, SAVED), { memoryCacheCapacity: '0', chatBackupCount: 10 });
  // Pressed and pressed back before the save: the file already says that.
  assert.equal(changedSettings({ extensions: true }, SAVED), null);
});

test('a file that could not be written is caught before the editor closes', async () => {
  assert.equal(await yamlProblem('listen: false\nperformance:\n  lazyLoadCharacters: true\n'), null);
  const unclosed = await yamlProblem('listen: [unclosed\n');
  assert.ok(unclosed);
  assert.match(unclosed.detail, /at line \d+, column \d+/u, 'the parser says where');
  // Parses, but is not a file of settings.
  assert.deepEqual(await yamlProblem('- just\n- a list\n'), { detail: '' });
  assert.deepEqual(await yamlProblem(''), { detail: '' });
});
