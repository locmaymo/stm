import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cloneExtension, compareFolders, ExtensionTrash, parseBranch, parseInstallUrl, placeExtension, setExtensionEnabled, TRASH_DAYS, withExtensionEnabled } from '../src/extension-changes.js';
import { findExtensions } from '../src/extensions.js';

const exec = promisify(execFile);
const gitMissing = await exec('git', ['--version']).then(() => false, () => true);
const needsGit = gitMissing ? 'git is not installed here, so clones cannot be exercised' : false;

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', directory, '-c', 'user.email=stm@test.example', '-c', 'user.name=STM Test', '-c', 'commit.gpgsign=false', ...args]);
  return stdout.trim();
}

/** A repository on this disk, as a `file://` address git will clone from when allowed to. */
async function repository(files: Record<string, string>): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stm-extension-source-'));
  await git(path, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true });
    await writeFile(join(path, name), content);
  }
  await git(path, 'add', '.');
  await git(path, 'commit', '-q', '-m', 'one');
  return `file://${path.replaceAll('\\', '/')}`;
}

test('only a plain https address of a repository is installed from', () => {
  assert.deepEqual(parseInstallUrl('https://example.com/owner/Quick-Notes.git'), { url: 'https://example.com/owner/Quick-Notes.git', folder: 'Quick-Notes' });
  assert.equal(parseInstallUrl(' https://example.com/owner/notes ').folder, 'notes');
  const refusals: Array<[string, string]> = [
    ['http://example.com/owner/notes', 'extension_url_scheme'],
    ['file:///etc/notes', 'extension_url_scheme'],
    ['ssh://example.com/owner/notes', 'extension_url_scheme'],
    ['git://example.com/owner/notes', 'extension_url_scheme'],
    ['git@example.com:owner/notes.git', 'extension_url_scheme'],
    ['https://token@example.com/owner/notes', 'extension_url_credentials'],
    ['https://name:secret@example.com/owner/notes', 'extension_url_credentials'],
    ['https://example.com/owner/notes?token=secret', 'extension_url_invalid'],
    ['https://example.com/owner/notes#main', 'extension_url_invalid'],
    ['https://example.com/', 'extension_url_invalid'],
    ['https://example.com/owner/%2e%2e', 'extension_url_invalid'],
    ['https://example.com/owner/.hidden', 'extension_url_invalid'],
    ['https://example.com/owner/..', 'extension_url_invalid'],
    ['not an address', 'extension_url_invalid'],
  ];
  for (const [url, code] of refusals) assert.throws(() => parseInstallUrl(url), { code }, url);
  assert.throws(() => parseInstallUrl(42), { code: 'extension_url_invalid' });
});

test('a branch is a name and never an option or a path', () => {
  assert.equal(parseBranch(undefined), null);
  assert.equal(parseBranch(''), null);
  assert.equal(parseBranch('main'), 'main');
  assert.equal(parseBranch('release/1.2'), 'release/1.2');
  for (const value of ['-c', '--upload-pack=x', '../main', 'a..b', 'x.lock', 'a//b', 'a/', 42]) {
    assert.throws(() => parseBranch(value), { code: 'extension_branch_invalid' }, String(value));
  }
});

test('switching an extension writes settings.json back byte for byte as SillyTavern would', () => {
  // The shape SillyTavern writes: four spaces, no newline at the end, and
  // text in any language left as it is.
  const original = JSON.stringify({ firstRun: false, username: 'Lộc', power_user: { theme: 'Cappuccino', chat_width: 50 }, extension_settings: { disabledExtensions: ['third-party/old'], memory: { enabled: true } }, unicode: 'chữ ✓' }, null, 4);
  const off = withExtensionEnabled(original, 'third-party/Notes', false);
  assert.ok(off);
  const expected = JSON.parse(original) as { extension_settings: { disabledExtensions: string[] } };
  expected.extension_settings.disabledExtensions.push('third-party/Notes');
  assert.equal(off, JSON.stringify(expected, null, 4), 'only the list changed');
  assert.equal(withExtensionEnabled(off, 'third-party/Notes', true), original, 'and switching it back is the original file');
  assert.equal(withExtensionEnabled(original, 'third-party/old', false), null, 'already off is nothing to write');
  assert.equal(withExtensionEnabled(original, 'third-party/Notes', true), null, 'already on is nothing to write');
});

test('settings without an extension list get one, and settings that are not JSON are refused', () => {
  const written = withExtensionEnabled(JSON.stringify({ firstRun: false }, null, 4), 'third-party/Notes', false);
  assert.deepEqual(JSON.parse(written!), { firstRun: false, extension_settings: { disabledExtensions: ['third-party/Notes'] } });
  assert.throws(() => withExtensionEnabled('{ not json', 'third-party/Notes', false), { code: 'extension_settings_unreadable' });
  assert.throws(() => withExtensionEnabled('[]', 'third-party/Notes', false), { code: 'extension_settings_unreadable' });
});

test('a settings file SillyTavern has not written yet is not invented', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-extension-settings-'));
  await assert.rejects(setExtensionEnabled(join(root, 'settings.json'), 'third-party/Notes', false), { code: 'extension_settings_missing' });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ firstRun: false }, null, 4));
  assert.equal(await setExtensionEnabled(join(root, 'settings.json'), 'third-party/Notes', false), true);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).extension_settings.disabledExtensions, ['third-party/Notes']);
  assert.deepEqual((await readdir(root)).sort(), ['settings.json'], 'no temporary file is left behind');
});

test('a clone is made aside, checked for a manifest, and only then put in place', { skip: needsGit }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'stm-extension-scratch-'));
  const extensions = join(await mkdtemp(join(tmpdir(), 'stm-extension-root-')), 'extensions');
  const options = { gitCommand: 'git', scratch, protocols: ['file'] };
  const clone = await cloneExtension(options, await repository({ 'manifest.json': '{"display_name":"Notes"}', 'index.js': '' }), null);
  assert.ok(clone.startsWith(scratch));
  const placed = await placeExtension(clone, extensions, 'Notes');
  assert.equal(placed, join(extensions, 'Notes'));
  assert.deepEqual(await readdir(scratch), [], 'nothing is left in the scratch folder');
  const second = await cloneExtension(options, await repository({ 'manifest.json': '{}' }), null);
  await assert.rejects(placeExtension(second, extensions, 'Notes'), { code: 'extension_exists' });
  assert.deepEqual(await readdir(scratch), [], 'a refused clone is thrown away');
});

test('a repository without a manifest is not an extension, and leaves nothing behind', { skip: needsGit }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'stm-extension-scratch-'));
  await assert.rejects(cloneExtension({ gitCommand: 'git', scratch, protocols: ['file'] }, await repository({ 'README.md': 'hello' }), null), { code: 'extension_not_an_extension' });
  assert.deepEqual(await readdir(scratch), []);
});

test('git is held to the transports it is given', { skip: needsGit }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'stm-extension-scratch-'));
  await assert.rejects(cloneExtension({ gitCommand: 'git', scratch }, await repository({ 'manifest.json': '{}' }), null), { code: 'extension_clone_failed' });
  assert.deepEqual(await readdir(scratch), []);
});

test('a removed extension waits in the trash for a week, and goes back exactly where it was', async () => {
  let now = new Date('2026-10-13T08:00:00Z');
  const base = await mkdtemp(join(tmpdir(), 'stm-extension-trash-'));
  const userRoot = join(base, 'default-user');
  await mkdir(join(userRoot, 'extensions', 'Notes'), { recursive: true });
  await writeFile(join(userRoot, 'extensions', 'Notes', 'manifest.json'), '{"display_name":"Notes"}');
  await writeFile(join(userRoot, 'extensions', 'Notes', 'my-data.json'), '{"mine":true}');
  const trash = new ExtensionTrash(join(base, 'trash'), () => now);
  const [entry] = (await findExtensions({ userRoot, runtimeRoot: null })).extensions;
  const item = await trash.put(entry!);
  assert.deepEqual((await findExtensions({ userRoot, runtimeRoot: null })).extensions, []);
  assert.equal(item.displayName, 'Notes');
  assert.equal(Date.parse(item.expiresAt) - Date.parse(item.removedAt), TRASH_DAYS * 24 * 60 * 60 * 1000);
  assert.deepEqual((await trash.list()).map((listed) => listed.id), [item.id]);

  await assert.rejects(trash.restore('../../etc'), { code: 'extension_trash_not_found' });
  await trash.restore(item.id);
  assert.equal(await readFile(join(userRoot, 'extensions', 'Notes', 'my-data.json'), 'utf8'), '{"mine":true}');
  assert.deepEqual(await trash.list(), []);

  const again = await trash.put((await findExtensions({ userRoot, runtimeRoot: null })).extensions[0]!);
  await mkdir(join(userRoot, 'extensions', 'Notes'));
  await assert.rejects(trash.restore(again.id), { code: 'extension_exists' }, 'something new in its place is not overwritten');

  now = new Date(now.getTime() + TRASH_DAYS * 24 * 60 * 60 * 1000 - 1000);
  assert.equal(await trash.purge(), 0, 'a day short of a week is kept');
  now = new Date(now.getTime() + 2000);
  assert.equal(await trash.purge(), 1);
  assert.deepEqual(await trash.list(), []);
});

test('a comparison names what a fresh clone would add, change and take away', async () => {
  const current = await mkdtemp(join(tmpdir(), 'stm-extension-current-'));
  const incoming = await mkdtemp(join(tmpdir(), 'stm-extension-incoming-'));
  await writeFile(join(current, 'manifest.json'), '{"version":"1"}');
  await writeFile(join(incoming, 'manifest.json'), '{"version":"2"}');
  await writeFile(join(current, 'index.js'), 'a\r\nb\r\n');
  await writeFile(join(incoming, 'index.js'), 'a\nb\n');
  await writeFile(join(current, 'my-data.json'), '{}');
  await writeFile(join(incoming, 'new.js'), '');
  await mkdir(join(incoming, '.git'));
  await writeFile(join(incoming, '.git', 'HEAD'), 'ref: refs/heads/main');
  await mkdir(join(current, 'node_modules'));
  await writeFile(join(current, 'node_modules', 'dep.js'), '');
  const result = await compareFolders(current, incoming);
  assert.deepEqual(result, { added: 1, removed: 1, changed: 1, unchanged: 1, samples: { added: ['new.js'], removed: ['my-data.json'], changed: ['manifest.json'] } });
});
