import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, getPlatformPaths } from '../../../packages/platform/src/index.js';

test('platform paths follow the documented durable roots', () => {
  assert.equal(detectPlatform({ platform: 'win32', env: {} }), 'windows');
  assert.equal(detectPlatform({ platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } }), 'termux');
  assert.equal(detectPlatform({ platform: 'linux', env: { STM_DATA_DIR: '/mnt/workspace/sillytavern-manager' } }), 'modelscope');
  assert.equal(detectPlatform({ platform: 'linux', env: { STM_DOCKER: '1' } }), 'docker');

  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: 'D:/manager-test-data' } });
  assert.match(paths.root, /manager-test-data$/);
  assert.match(paths.state, /state$/);
});
