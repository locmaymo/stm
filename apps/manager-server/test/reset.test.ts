import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { eraseManagerData, RESET_DIRECTORIES } from '../src/reset.js';
import { StateStore } from '../src/state.js';
import { SessionStore } from '../src/sessions.js';

async function createPaths(): Promise<ReturnType<typeof getPlatformPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'stm-reset-'));
  return getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
}

/** A file in every directory a reset is meant to empty, plus one it is not. */
async function fill(paths: ReturnType<typeof getPlatformPaths>): Promise<void> {
  for (const directory of [...RESET_DIRECTORIES, 'bin'] as const) {
    await mkdir(join(paths[directory], 'inner'), { recursive: true });
    await writeFile(join(paths[directory], 'inner', 'kept.txt'), 'something somebody made', 'utf8');
  }
}

test('a reset empties every directory that holds what somebody made, and leaves the tools', async () => {
  const paths = await createPaths();
  await fill(paths);
  const report = await eraseManagerData(paths, () => undefined);

  assert.equal(report.failures.length, 0);
  assert.equal(report.removed.length, RESET_DIRECTORIES.length);
  for (const directory of RESET_DIRECTORIES) {
    assert.deepEqual(await readdir(paths[directory]), [], `${directory} is empty`);
  }
  // cloudflared is a program downloaded from Cloudflare, not anything anybody
  // typed in here, and fetching it again would cost a download for nothing.
  assert.deepEqual(await readdir(join(paths.bin, 'inner')), ['kept.txt']);
});

test('a directory that is the root of a filesystem is refused rather than emptied', async () => {
  const paths = await createPaths();
  await fill(paths);
  // What an empty or malformed STM_DATA_DIR resolves to. Obeying it would take
  // the machine with it, so it is the one input this must refuse.
  const root = parse(paths.root).root;
  const report = await eraseManagerData({ ...paths, archives: root }, () => undefined);

  assert.deepEqual(report.failures.map((failure) => failure.directory), ['archives']);
  // And the refusal stops that one directory, not the reset.
  assert.equal(report.removed.length, RESET_DIRECTORIES.length - 1);
  assert.deepEqual(await readdir(paths.profiles), []);
});

test('the same directory named twice is emptied once', async () => {
  const paths = await createPaths();
  await fill(paths);
  // A hosted platform puts `tmp` outside the data root, and nothing stops two
  // of these being pointed at one place by hand.
  const report = await eraseManagerData({ ...paths, tmp: paths.outbox }, () => undefined);

  assert.equal(report.removed.length, RESET_DIRECTORIES.length - 1);
  assert.equal(new Set(report.removed).size, report.removed.length);
});

test('the state store reads the disk again after the file under it is erased', async () => {
  const paths = await createPaths();
  const store = new StateStore({ paths });
  await store.load();
  await store.saveAdminPassword('scrypt$16384$8$1$salt$key');
  assert.notEqual((await store.getPersisted()).adminPasswordHash, null);

  await eraseManagerData(paths, () => undefined);
  await store.forget();

  // Without forgetting, the password just erased would still be answered with
  // and written back on the next change - the wipe would undo itself.
  const fresh = await store.getPersisted();
  assert.equal(fresh.adminPasswordHash, null);
  assert.equal(JSON.parse(await readFile(join(paths.state, 'manager-state.json'), 'utf8')).adminPasswordHash, null);
});

test('a reset ends every console session, not only the one that asked', async () => {
  const sessions = new SessionStore();
  const mine = sessions.create();
  const theirs = sessions.create();

  assert.equal(sessions.revokeAll(), 2);
  assert.equal(sessions.get(mine.token), null);
  assert.equal(sessions.get(theirs.token), null);
  assert.equal(sessions.size(), 0);
});
