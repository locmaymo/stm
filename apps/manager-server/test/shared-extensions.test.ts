import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptSharedExtensions } from '../src/shared-extensions.js';

const NOW = Date.parse('2026-11-28T08:00:00.000Z');

/** A runtime and one user's folder, the way a profile on a current SillyTavern lays them out. */
async function layout(users: readonly string[] = ['default-user']): Promise<{ runtimePath: string; userRoot: string; shared: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-shared-extensions-'));
  const runtimePath = join(root, 'runtime');
  const shared = join(runtimePath, 'public', 'scripts', 'extensions', 'third-party');
  await mkdir(shared, { recursive: true });
  const data = join(root, 'data');
  // SillyTavern's own bookkeeping sits beside the users and is not one.
  await mkdir(join(data, '_storage'), { recursive: true });
  for (const user of users) await mkdir(join(data, user), { recursive: true });
  return { runtimePath, userRoot: join(data, 'default-user'), shared };
}

/** An installed extension, last touched `ageMs` before NOW. */
async function extension(parent: string, name: string, options: { manifest?: boolean; ageMs?: number; lock?: boolean } = {}): Promise<void> {
  const folder = join(parent, name);
  await mkdir(join(folder, '.git'), { recursive: true });
  await writeFile(join(folder, 'index.js'), `// ${name}\n`, 'utf8');
  if (options.lock) await writeFile(join(folder, '.git', 'index.lock'), '', 'utf8');
  if (options.manifest !== false) await writeFile(join(folder, 'manifest.json'), JSON.stringify({ display_name: name }), 'utf8');
  const at = (NOW - (options.ageMs ?? 60_000)) / 1000;
  if (options.manifest !== false) await utimes(join(folder, 'manifest.json'), at, at);
  await utimes(folder, at, at);
}

test('an extension installed for all users moves into the user’s own folder, and nothing half there does', async () => {
  const { runtimePath, userRoot, shared } = await layout();
  await extension(shared, 'finished');
  await extension(shared, 'no-manifest', { manifest: false });
  await extension(shared, 'being-cloned', { lock: true });
  await extension(shared, 'just-arrived', { ageMs: 2_000 });
  await extension(shared, 'already-mine');
  await extension(join(userRoot, 'extensions'), 'already-mine');
  const lines: string[] = [];

  const moved = await adoptSharedExtensions({ runtimePath, userRoot, now: () => NOW, logger: (line) => { lines.push(typeof line === 'string' ? line : line.code); } });

  assert.deepEqual(moved, ['finished']);
  assert.equal(await readFile(join(userRoot, 'extensions', 'finished', 'index.js'), 'utf8'), '// finished\n', 'whole, git folder and all');
  assert.ok((await readdir(join(userRoot, 'extensions', 'finished'))).includes('.git'));
  assert.deepEqual((await readdir(shared)).sort(), ['already-mine', 'being-cloned', 'just-arrived', 'no-manifest']);
  assert.deepEqual(lines, ['extensions.adopted']);

  // Once it has finished arriving, the next look moves it too.
  assert.deepEqual(await adoptSharedExtensions({ runtimePath, userRoot, now: () => NOW + 60_000 }), ['just-arrived']);
});

test('with more than one user, "all users" means what it says and nothing moves', async () => {
  const { runtimePath, userRoot, shared } = await layout(['default-user', 'alice']);
  await extension(shared, 'for-everyone');
  assert.deepEqual(await adoptSharedExtensions({ runtimePath, userRoot, now: () => NOW }), []);
  assert.deepEqual(await readdir(shared), ['for-everyone']);
});

test('a runtime with no shared extensions folder is nothing to do', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-shared-extensions-'));
  await mkdir(join(root, 'data', 'default-user'), { recursive: true });
  assert.deepEqual(await adoptSharedExtensions({ runtimePath: join(root, 'runtime'), userRoot: join(root, 'data', 'default-user') }), []);
});
