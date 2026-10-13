import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findExtensions } from '../src/extensions.js';
import { CHECK_TTL_MS, ExtensionUpdater } from '../src/extension-updates.js';

const exec = promisify(execFile);
const gitMissing = await exec('git', ['--version']).then(() => false, () => true);
const needsGit = gitMissing ? 'git is not installed here, so updates cannot be exercised' : false;

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', directory, '-c', 'user.email=stm@test.example', '-c', 'user.name=STM Test', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args]);
  return stdout.trim();
}

/**
 * An extension cloned from a remote that lives on this disk, the way
 * SillyTavern clones one, plus a second checkout standing in for its author.
 */
async function setUp(): Promise<{ base: string; userRoot: string; path: string; author: string; publish: (file: string, content: string) => Promise<string>; updater: ExtensionUpdater; find: () => ReturnType<typeof findExtensions> }> {
  const base = await mkdtemp(join(tmpdir(), 'stm-extension-updates-'));
  const remote = join(base, 'remote.git');
  const author = join(base, 'author');
  await exec('git', ['init', '--bare', '-q', '-b', 'main', remote]);
  await exec('git', ['clone', '-q', remote, author]);
  await git(author, 'checkout', '-q', '-b', 'main');
  await writeFile(join(author, 'manifest.json'), JSON.stringify({ display_name: 'Notes', version: '1.0.0' }));
  await git(author, 'add', '.');
  await git(author, 'commit', '-q', '-m', 'one');
  await git(author, 'push', '-q', 'origin', 'main');
  const userRoot = join(base, 'data', 'default-user');
  await mkdir(join(userRoot, 'extensions'), { recursive: true });
  const path = join(userRoot, 'extensions', 'Notes');
  await exec('git', ['clone', '-q', '--depth', '1', `file://${remote.replaceAll('\\', '/')}`, path]);
  const publish = async (file: string, content: string): Promise<string> => {
    await writeFile(join(author, file), content);
    await git(author, 'add', '.');
    await git(author, 'commit', '-q', '-m', `change ${file}`);
    await git(author, 'push', '-q', 'origin', 'main');
    return git(author, 'rev-parse', 'HEAD');
  };
  const updater = new ExtensionUpdater({ stateDir: join(base, 'state') });
  return { base, userRoot, path, author, publish, updater, find: () => findExtensions({ userRoot, runtimeRoot: null }) };
}

test('a check says how far behind its remote an extension is, and is kept for an hour', { skip: needsGit }, async () => {
  let now = new Date('2026-10-13T08:00:00Z');
  const place = await setUp();
  const updater = new ExtensionUpdater({ stateDir: join(place.base, 'state'), now: () => now });
  assert.equal(updater.isStale(), true, 'never checked is stale');
  await place.publish('index.js', 'one');
  await place.publish('index.js', 'two');
  const found = (await place.find()).extensions;
  const progress: Array<[number, number]> = [];
  await updater.check(found, (done, total) => progress.push([done, total]));
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
  const [notes] = await updater.describe(found);
  assert.equal(notes?.update?.behind, 2);
  assert.equal(notes?.update?.problem, null);
  assert.equal(updater.isStale(), false);
  now = new Date(now.getTime() + CHECK_TTL_MS);
  assert.equal(updater.isStale(), true);
});

test('an update moves forward, and a roll back returns to where it was and back onto the branch after', { skip: needsGit }, async () => {
  const place = await setUp();
  const first = await git(place.path, 'rev-parse', 'HEAD');
  const second = await place.publish('index.js', 'new');

  const updated = await place.updater.update((await place.find()).extensions[0]!);
  assert.deepEqual(updated, { outcome: 'updated', from: first, to: second });
  assert.equal(await git(place.path, 'rev-parse', 'HEAD'), second);
  const afterUpdate = (await place.updater.describe((await place.find()).extensions))[0];
  assert.equal(afterUpdate?.canRollBack, true);
  assert.equal(afterUpdate?.update?.behind, 0);
  assert.match(await readFile(join(place.base, 'state', 'extensions-history.json'), 'utf8'), new RegExp(first));

  const rolled = await place.updater.rollBack((await place.find()).extensions[0]!);
  assert.deepEqual(rolled, { from: second, to: first });
  const afterRollBack = (await place.find()).extensions[0]!;
  assert.equal(afterRollBack.info.git?.commit, first);
  assert.equal(afterRollBack.info.git?.branch, null, 'a roll back leaves the branch where the update put it');
  const described = (await place.updater.describe([afterRollBack]))[0];
  assert.equal(described?.canRollBack, false, 'there is one step back, not a ladder');
  assert.equal(described?.update?.behind, 1, 'and the newer version is offered again');

  // A fresh updater is a restarted manager: the branch to go back onto was written down.
  const restarted = new ExtensionUpdater({ stateDir: join(place.base, 'state') });
  const again = await restarted.update(afterRollBack);
  assert.equal(again.outcome, 'updated');
  const back = (await place.find()).extensions[0]!;
  assert.equal(back.info.git?.branch, 'main');
  assert.equal(back.info.git?.commit, second);
});

test('nothing new is an answer, not an update, and leaves nothing to roll back', { skip: needsGit }, async () => {
  const place = await setUp();
  const result = await place.updater.update((await place.find()).extensions[0]!);
  assert.equal(result.outcome, 'upToDate');
  assert.equal((await place.updater.describe((await place.find()).extensions))[0]?.canRollBack, false);
});

test('an extension edited by hand is left as it is', { skip: needsGit }, async () => {
  const place = await setUp();
  await place.publish('index.js', 'new');
  await writeFile(join(place.path, 'manifest.json'), JSON.stringify({ display_name: 'My own edit' }));
  await assert.rejects(place.updater.update((await place.find()).extensions[0]!), { code: 'extension_local_changes' });
  assert.match(await readFile(join(place.path, 'manifest.json'), 'utf8'), /My own edit/u);
});

test('a checkout with commits of its own is refused rather than reset', { skip: needsGit }, async () => {
  const place = await setUp();
  await place.publish('index.js', 'theirs');
  await writeFile(join(place.path, 'mine.js'), 'mine');
  await git(place.path, 'add', '.');
  await git(place.path, 'commit', '-q', '-m', 'mine');
  const mine = await git(place.path, 'rev-parse', 'HEAD');
  await assert.rejects(place.updater.update((await place.find()).extensions[0]!), { code: 'extension_diverged' });
  assert.equal(await git(place.path, 'rev-parse', 'HEAD'), mine);
});

test('a roll back with nothing recorded is refused', { skip: needsGit }, async () => {
  const place = await setUp();
  await assert.rejects(place.updater.rollBack((await place.find()).extensions[0]!), { code: 'extension_no_rollback' });
});

test('an extension that follows no remote branch is reported by the check, not thrown', { skip: needsGit }, async () => {
  const place = await setUp();
  await git(place.path, 'branch', '--unset-upstream');
  const found = (await place.find()).extensions;
  await place.updater.check(found);
  const [notes] = await place.updater.describe(found);
  assert.equal(notes?.update?.behind, null);
  assert.equal(notes?.update?.problem, 'extension_no_upstream');
});

test('a remote that cannot be reached is reported by the check', { skip: needsGit }, async () => {
  const place = await setUp();
  await git(place.path, 'remote', 'set-url', 'origin', `file://${join(place.base, 'gone.git').replaceAll('\\', '/')}`);
  const found = (await place.find()).extensions;
  await place.updater.check(found);
  assert.equal((await place.updater.describe(found))[0]?.update?.problem, 'extension_fetch_failed');
});
