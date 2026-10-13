import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extensionKey, listExtensions, safeHomePage, safeRemote } from '../src/extensions.js';

const exec = promisify(execFile);
const gitMissing = await exec('git', ['--version']).then(() => false, () => true);
const needsGit = gitMissing ? 'git is not installed here, so the checkout cases cannot run' : false;

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', directory, '-c', 'user.email=stm@test.example', '-c', 'user.name=STM Test', '-c', 'commit.gpgsign=false', ...args]);
  return stdout.trim();
}

async function extension(root: string, name: string, manifest: unknown, files: Record<string, string> = {}): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  if (manifest !== undefined) await writeFile(join(path, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(path, file, '..'), { recursive: true });
    await writeFile(join(path, file), content);
  }
  return path;
}

/** A profile's user directory and an installed copy of SillyTavern, both empty. */
async function roots(): Promise<{ userRoot: string; runtimeRoot: string; user: string; global: string }> {
  const base = await mkdtemp(join(tmpdir(), 'stm-extensions-'));
  const userRoot = join(base, 'data', 'default-user');
  const runtimeRoot = join(base, 'runtime');
  const user = join(userRoot, 'extensions');
  const global = join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party');
  await mkdir(user, { recursive: true });
  await mkdir(global, { recursive: true });
  return { userRoot, runtimeRoot, user, global };
}

test('both places are read, and a folder without a manifest is not an extension', async () => {
  const place = await roots();
  await extension(place.user, 'Quick-Notes', { display_name: 'Quick Notes', version: '1.2.0', author: 'someone', homePage: 'https://example.com/quick-notes' });
  await extension(place.global, 'Gallery-Plus', { display_name: 'Gallery Plus', version: 3 });
  await extension(place.user, 'half-unzipped', undefined, { 'index.js': '' });
  await writeFile(join(place.user, 'stray.txt'), 'not a folder');
  const list = await listExtensions(place);
  assert.deepEqual(list.extensions.map((item) => [item.scope, item.name]), [['user', 'Quick-Notes'], ['global', 'Gallery-Plus']]);
  const notes = list.extensions[0]!;
  assert.equal(notes.key, 'third-party/Quick-Notes');
  assert.equal(notes.displayName, 'Quick Notes');
  assert.equal(notes.version, '1.2.0');
  assert.equal(notes.author, 'someone');
  assert.equal(notes.homePage, 'https://example.com/quick-notes');
  assert.equal(list.extensions[1]!.version, '3', 'a number written as the version still reads as one');
});

test('the disabled list in settings.json says which are off, and is shared by both places', async () => {
  const place = await roots();
  await extension(place.user, 'on', {});
  await extension(place.user, 'off', {});
  await extension(place.global, 'off-too', {});
  await writeFile(join(place.userRoot, 'settings.json'), JSON.stringify({ extension_settings: { disabledExtensions: [extensionKey('off'), extensionKey('off-too'), 'memory'] } }, null, 4));
  const enabled = Object.fromEntries((await listExtensions(place)).extensions.map((item) => [item.name, item.enabled]));
  assert.deepEqual(enabled, { on: true, off: false, 'off-too': false });
});

test('settings SillyTavern has not written yet, or cannot be read, leave everything on', async () => {
  const place = await roots();
  await extension(place.user, 'one', {});
  assert.equal((await listExtensions(place)).extensions[0]!.enabled, true);
  await writeFile(join(place.userRoot, 'settings.json'), '{ not json');
  assert.equal((await listExtensions(place)).extensions[0]!.enabled, true);
});

test('a global extension with a user one of the same name is the one SillyTavern does not load', async () => {
  const place = await roots();
  await extension(place.user, 'Twin', { version: '2.0.0' });
  await extension(place.global, 'Twin', { version: '1.0.0' });
  const [user, global] = (await listExtensions(place)).extensions;
  assert.equal(user?.shadowed, false);
  assert.equal(global?.shadowed, true);
});

test('a manifest that is not JSON, or starts with a byte order mark, still lists the folder', async () => {
  const place = await roots();
  await extension(place.user, 'broken', '{ "display_name": ');
  await extension(place.user, 'marked', `﻿${JSON.stringify({ display_name: 'Marked' })}`);
  const names = (await listExtensions(place)).extensions.map((item) => item.displayName);
  assert.deepEqual(names, ['broken', 'Marked']);
});

test('only an ordinary web address is offered as a home page, without credentials', () => {
  assert.equal(safeHomePage('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeHomePage('https://name:token@example.com/x'), 'https://example.com/x');
  assert.equal(safeHomePage('javascript:alert(1)'), null);
  assert.equal(safeHomePage('file:///etc/passwd'), null);
  assert.equal(safeHomePage('not a url'), null);
  assert.equal(safeHomePage(42), null);
});

test('a remote is shown without the user name or token it was cloned with', () => {
  assert.equal(safeRemote('https://example.com/owner/repo.git'), 'https://example.com/owner/repo.git');
  assert.equal(safeRemote('https://ghp_secret@example.com/owner/repo'), 'https://example.com/owner/repo');
  assert.equal(safeRemote('https://name:secret@example.com/owner/repo\n'), 'https://example.com/owner/repo');
  assert.equal(safeRemote('git@example.com:owner/repo.git'), 'git@example.com:owner/repo.git');
  assert.equal(safeRemote('name:secret@example.com:owner/repo.git'), 'example.com:owner/repo.git');
  assert.equal(safeRemote('   '), null);
});

test('the size leaves out nothing, but counts node_modules apart', async () => {
  const place = await roots();
  await extension(place.user, 'heavy', {}, { 'index.js': 'x'.repeat(100), 'lib/a.js': 'y'.repeat(50), 'node_modules/dep/index.js': 'z'.repeat(1000), 'lib/node_modules/inner.js': 'w'.repeat(10) });
  const [heavy] = (await listExtensions(place)).extensions;
  assert.equal(heavy?.bytes, 2 + 100 + 50, 'the manifest, index.js and lib/a.js');
  assert.equal(heavy?.dependencyBytes, 1010);
});

test('nothing installed and no profile is an empty list, not an error', async () => {
  assert.deepEqual(await listExtensions({ userRoot: null, runtimeRoot: null }), { extensions: [], gitAvailable: true });
  const base = await mkdtemp(join(tmpdir(), 'stm-extensions-none-'));
  assert.deepEqual((await listExtensions({ userRoot: join(base, 'missing'), runtimeRoot: join(base, 'missing') })).extensions, []);
});

test('a cloned extension reports its branch, commit and remote', { skip: needsGit }, async () => {
  const place = await roots();
  const path = await extension(place.user, 'cloned', { display_name: 'Cloned' });
  await git(path, 'init', '-q', '-b', 'main');
  await git(path, 'remote', 'add', 'origin', 'https://name:secret@example.com/owner/cloned.git');
  await git(path, 'add', '.');
  await git(path, 'commit', '-q', '-m', 'one');
  const commit = await git(path, 'rev-parse', 'HEAD');
  const [cloned] = (await listExtensions(place)).extensions;
  assert.equal(cloned?.hasGit, true);
  assert.equal(cloned?.git?.commit, commit);
  assert.equal(cloned?.git?.branch, 'main');
  assert.equal(cloned?.git?.remote, 'https://example.com/owner/cloned.git');
  assert.ok(cloned?.git?.committedAt && !Number.isNaN(Date.parse(cloned.git.committedAt)));
  assert.ok((cloned?.bytes ?? 0) > 2, 'the git history counts towards the size');

  await git(path, 'checkout', '-q', '--detach');
  assert.equal((await listExtensions(place)).extensions[0]?.git?.branch, null, 'a detached checkout is on no branch');
});

test('a global extension copied into SillyTavern’s own checkout does not report SillyTavern’s commit', { skip: needsGit }, async () => {
  const place = await roots();
  await writeFile(join(place.runtimeRoot, 'server.js'), '');
  await git(place.runtimeRoot, 'init', '-q');
  await git(place.runtimeRoot, 'add', 'server.js');
  await git(place.runtimeRoot, 'commit', '-q', '-m', 'sillytavern');
  await extension(place.global, 'copied', {});
  // A `.git` that is not a repository must not send git looking further up.
  await extension(place.global, 'broken-git', {}, { '.git/HEAD': 'nonsense' });
  const list = await listExtensions(place);
  const copied = list.extensions.find((item) => item.name === 'copied');
  const broken = list.extensions.find((item) => item.name === 'broken-git');
  assert.equal(copied?.hasGit, false);
  assert.equal(copied?.git, null);
  assert.equal(broken?.hasGit, true);
  assert.equal(broken?.git, null);
});

test('without git the list still answers, and says git is missing', async () => {
  const place = await roots();
  await extension(place.user, 'cloned', {}, { '.git/HEAD': 'ref: refs/heads/main\n' });
  const list = await listExtensions(place, { gitCommand: join(place.userRoot, 'no-such-git') });
  assert.equal(list.gitAvailable, false);
  assert.equal(list.extensions[0]?.hasGit, true);
  assert.equal(list.extensions[0]?.git, null);
});
