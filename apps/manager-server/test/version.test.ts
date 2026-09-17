import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { MANAGER_VERSION, resolveManagerVersion } from '../src/version.js';

const repositoryVersion = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

test('a checkout reports the version in its own manifest', () => {
  assert.equal(MANAGER_VERSION, repositoryVersion);
  assert.notEqual(MANAGER_VERSION, '0.1.0');
});

test('STM_VERSION wins, for a layout the walk does not suit', () => {
  assert.equal(resolveManagerVersion({ STM_VERSION: '9.9.9' }), '9.9.9');
  // Blank is not an answer; it falls through to the walk.
  assert.equal(resolveManagerVersion({ STM_VERSION: '  ' }), repositoryVersion);
});

test('a manifest with no version is walked past, not reported as one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-version-'));
  const nested = join(root, 'app', 'apps', 'manager-server', 'src');
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'outer', version: '7.7.7' }), 'utf8');
  // What the Windows bundle used to ship: dependencies, and no version.
  await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ name: 'runtime', private: true }), 'utf8');
  assert.equal(resolveManagerVersion({}, join(nested, 'version.js')), '7.7.7');
});

test('nothing to find is reported as unknown rather than as a real version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-version-'));
  // Deeper than the walk is allowed to climb, so it cannot reach a manifest
  // belonging to whatever directory the manager happens to sit inside.
  const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
  await mkdir(deep, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
  assert.equal(resolveManagerVersion({}, join(deep, 'version.js')), '0.0.0');
});
