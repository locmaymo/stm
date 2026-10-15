import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { logLineText } from '../../contracts/src/index.js';
import { getPlatformPaths } from '../../platform/src/index.js';
import { ProfileStore } from '../src/index.js';
import { ProfileVault } from '../src/vault.js';

async function put(root: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body, 'utf8');
}

async function tree(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative);
      else found[relative] = await readFile(join(directory, entry.name), 'utf8');
    }
  };
  await walk(root, '');
  return found;
}

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** A machine: its own disk, and the data directory it shares with the next one. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stm-vault-'));
  const durable = join(root, 'data-directory', 'profiles', '.profile-store');
  const legacy = join(root, 'data-directory', 'profiles', '.profile-data');
  let machine = 0;
  const lines: string[] = [];
  const vault = (local = join(root, `machine-${++machine}`)) => new ProfileVault({ local, durable, legacy, logger: (line) => lines.push(logLineText(line)) });
  return { root, durable, legacy, vault, lines };
}

test('a new machine gets back exactly what the last one wrote out, deletions included', async (t) => {
  const { root, durable, vault } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = vault();
  await first.restore();
  await put(first.local, 'p1/data/default-user/chats/Ann/one.jsonl', 'hello');
  await put(first.local, 'p1/data/default-user/characters/Ann.png', 'png');
  await put(first.local, 'p1/data/default-user/characters/Big.png', 'x'.repeat(10_000));
  await put(first.local, 'p1/config.yaml', 'port: 8000');
  await first.flush();
  assert.ok((await readdir(durable)).some((name) => name.startsWith('base-')), 'the first write is a base');

  // Small changes after the base go in the journal.
  await put(first.local, 'p1/data/default-user/chats/Ann/one.jsonl', 'hello again');
  await put(first.local, 'p1/data/default-user/chats/Ann/two.jsonl', 'second chat');
  await rm(join(first.local, 'p1/data/default-user/characters/Ann.png'));
  await first.flush();
  assert.ok((await readdir(durable)).some((name) => name.startsWith('journal-')));

  const second = vault();
  await second.restore();
  assert.deepEqual(await tree(second.local), await tree(first.local));
  assert.equal(await exists(join(second.local, 'p1/data/default-user/characters/Ann.png')), false, 'the deleted file stays deleted');
});

test('a change to most of the data is written as a new base, and the old pack and journal go', async (t) => {
  const { root, durable, vault } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = vault();
  await first.restore();
  await put(first.local, 'p1/a.txt', 'a');
  await first.flush();
  await put(first.local, 'p1/b.txt', 'b');
  await first.flush();
  const before = await readdir(durable);

  // A restored backup rewrites nearly everything.
  for (let index = 0; index < 20; index += 1) await put(first.local, `p1/restored/${index}.txt`, 'restored data '.repeat(50));
  await first.flush();
  const after = await readdir(durable);
  assert.equal(after.filter((name) => name.startsWith('base-')).length, 1);
  assert.equal(after.filter((name) => name.startsWith('journal-')).length, 0);
  assert.equal(after.some((name) => before.includes(name) && name !== 'head.json'), false, 'nothing from before is left');

  const second = vault();
  await second.restore();
  assert.deepEqual(await tree(second.local), await tree(first.local));
});

test('profiles kept file by file in the data directory are taken in once, and the old tree goes', async (t) => {
  const { root, legacy, durable, vault, lines } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await put(legacy, 'p1/data/default-user/chats/Ann/one.jsonl', 'kept for years');
  await put(legacy, 'p1/config.yaml', 'port: 8000');
  const lastChat = new Date('2025-03-04T05:06:07Z');
  await utimes(join(legacy, 'p1/data/default-user/chats/Ann/one.jsonl'), lastChat, lastChat);
  const first = vault();
  await first.restore();
  await first.settled();
  assert.deepEqual(await tree(first.local), { 'p1/data/default-user/chats/Ann/one.jsonl': 'kept for years', 'p1/config.yaml': 'port: 8000' });
  assert.equal(await exists(legacy), false, 'the old tree is removed once the pack holds it');
  // SillyTavern sorts by when a chat last changed; taking it in is not a change.
  assert.equal((await stat(join(first.local, 'p1/data/default-user/chats/Ann/one.jsonl'))).mtime.getTime(), lastChat.getTime());
  assert.ok((await readdir(durable)).includes('head.json'));
  assert.ok(lines.some((line) => line.includes('moved 2 profile files')), lines.join('\n'));

  const second = vault();
  await second.restore();
  assert.deepEqual(await tree(second.local), await tree(first.local));
});

test('a working copy already on this disk is kept, and only what changed since is written', async (t) => {
  const { root, durable, vault } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const local = join(root, 'same-machine');
  const first = vault(local);
  await first.restore();
  await put(local, 'p1/a.txt', 'a');
  await put(local, 'p1/large.png', 'x'.repeat(10_000));
  await first.flush();
  // Changed while the manager was down for a moment.
  await put(local, 'p1/b.txt', 'written while nothing was watching');

  const again = vault(local);
  await again.restore();
  assert.equal(await readFile(join(local, 'p1/b.txt'), 'utf8'), 'written while nothing was watching');
  await again.flush();
  assert.equal((await readdir(durable)).filter((name) => name.startsWith('journal-')).length, 1, 'one journal entry for the one new file');

  const elsewhere = vault();
  await elsewhere.restore();
  assert.deepEqual(await tree(elsewhere.local), await tree(local));
});

const headOf = async (durable: string) => JSON.parse(await readFile(join(durable, 'head.json'), 'utf8')) as { base: { file: string; files: number }; kept?: Array<{ file: string; files: number }> };

/** A profile of `count` small files and one large one, written out as a base. */
async function filled(vault: ProfileVault, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await put(vault.local, `p1/data/default-user/chats/Ann/${index}.jsonl`, `chat ${index}`);
  await put(vault.local, 'p1/data/default-user/characters/Ann.png', 'x'.repeat(50_000));
  await vault.flush();
}

test('an emptied working copy is never written as a base over one that holds data', async (t) => {
  const { root, durable, vault, lines } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = vault();
  await first.restore();
  await filled(first, 20);
  const base = (await headOf(durable)).base.file;
  await rm(join(first.local, 'p1'), { recursive: true, force: true });
  await first.flush();
  assert.ok((await readdir(durable)).includes(base), 'the base that holds the data is still there');

  // SillyTavern makes its default files again a moment later, which on its
  // own is a change to most of the (now tiny) tree and so a new base.
  await put(first.local, 'p1/data/default-user/settings.json', '{}');
  await first.flush();
  const head = await headOf(durable);
  assert.notEqual(head.base.file, base);
  assert.deepEqual(head.kept?.map((entry) => entry.file), [base], 'the pack with the data is kept beside the new base');
  assert.ok((await readdir(durable)).includes(base));
  assert.ok(lines.some((line) => line.includes(`where the last pack held 21`)), lines.join('\n'));

  // A rebase that is not a loss leaves what was kept alone.
  for (let index = 0; index < 3; index += 1) await put(first.local, `p1/data/default-user/chats/New/${index}.jsonl`, 'new');
  await first.flush();
  await put(first.local, 'p1/data/default-user/settings.json', '{"changed":true}'.repeat(10));
  await first.flush();
  assert.deepEqual((await headOf(durable)).kept?.map((entry) => entry.file), [base]);
});

test('losing most of the bytes keeps the earlier pack too, even with most files still there', async (t) => {
  const { root, durable, vault } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = vault();
  await first.restore();
  await filled(first, 20);
  const base = (await headOf(durable)).base.file;
  // The one large file goes and a small change rewrites the rest: most of the bytes are gone.
  await rm(join(first.local, 'p1/data/default-user/characters/Ann.png'));
  for (let index = 0; index < 20; index += 1) await put(first.local, `p1/data/default-user/chats/Ann/${index}.jsonl`, `chat ${index} edited`);
  await first.flush();
  const head = await headOf(durable);
  assert.notEqual(head.base.file, base, 'most of the tree changed, so this is a new base');
  assert.deepEqual(head.kept?.map((entry) => entry.file), [base]);
});

test('a pack kept from before goes once the profiles are whole again', async (t) => {
  const { root, durable, vault, lines } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = vault();
  await first.restore();
  await filled(first, 20);
  const base = (await headOf(durable)).base.file;
  const before = await tree(first.local);
  await rm(join(first.local, 'p1'), { recursive: true, force: true });
  await put(first.local, 'p1/data/default-user/settings.json', '{}');
  await first.flush();
  assert.deepEqual((await headOf(durable)).kept?.map((entry) => entry.file), [base]);

  // The data is put back.
  for (const [path, body] of Object.entries(before)) await put(first.local, path, body);
  await first.flush();
  assert.equal((await headOf(durable)).kept, undefined);
  assert.equal((await readdir(durable)).includes(base), false);
  assert.ok(lines.some((line) => line.includes(`removed the pack of 21 files kept from before`)), lines.join('\n'));

  const second = vault();
  await second.restore();
  assert.deepEqual(await tree(second.local), await tree(first.local));
});

test('no more than two packs are kept, and the smallest goes first', async (t) => {
  const { root, durable, vault } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = vault();
  await first.restore();
  await filled(first, 40);
  const largest = (await headOf(durable)).base.file;
  const shrinkTo = async (count: number): Promise<void> => {
    await rm(join(first.local, 'p1'), { recursive: true, force: true });
    for (let index = 0; index < count; index += 1) await put(first.local, `p1/data/default-user/chats/Ann/${index}.jsonl`, `rewritten ${count} ${index}`);
    await first.flush();
  };
  await shrinkTo(16);
  const middle = (await headOf(durable)).base.file;
  await shrinkTo(6);
  const smallest = (await headOf(durable)).base.file;
  await shrinkTo(1);
  const kept = (await headOf(durable)).kept?.map((entry) => entry.file);
  assert.deepEqual(kept, [largest, middle]);
  const names = await readdir(durable);
  assert.equal(names.includes(smallest), false);
  assert.ok(names.includes(largest) && names.includes(middle));
});

test('a disk without room for the profiles is refused before anything is copied', async (t) => {
  const { root, legacy, durable, lines } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await put(legacy, 'p1/data/default-user/characters/Big.png', 'x'.repeat(100_000));
  const cramped = new ProfileVault({ local: join(root, 'cramped'), durable, legacy, logger: (line) => lines.push(logLineText(line)), freeBytes: async () => 64 * 1024 * 1024 });
  await assert.rejects(cramped.restore(), /has 0\.1 GiB free and the profiles need about 0\.3 GiB/u);
  await cramped.flush();
  assert.deepEqual(await tree(join(root, 'cramped')), {}, 'nothing was copied');
  assert.equal(await exists(join(durable, 'head.json')), false, 'nothing was written out');
  assert.equal(await readFile(join(legacy, 'p1/data/default-user/characters/Big.png'), 'utf8'), 'x'.repeat(100_000), 'the data directory is as it was');

  // With room, the same machine takes them in.
  const roomy = new ProfileVault({ local: join(root, 'roomy'), durable, legacy, freeBytes: async () => 64 * 1024 * 1024 * 1024 });
  await roomy.restore();
  assert.equal((await tree(roomy.local))['p1/data/default-user/characters/Big.png']?.length, 100_000);
});

test('nothing is written out before the working copy has been filled', async (t) => {
  const { root, durable, vault } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(durable, { recursive: true });
  await writeFile(join(durable, 'head.json'), '{"something":"unreadable"}', 'utf8');
  const broken = vault();
  await assert.rejects(broken.restore());
  await put(broken.local, 'p1/a.txt', 'a');
  await broken.flush();
  assert.deepEqual(await readdir(durable), ['head.json'], 'the data directory was left as it was');
});

test('erasing empties the working copy and the data directory, and stays erased', async (t) => {
  const { root, durable, vault } = await setup();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = vault();
  await first.restore();
  await put(first.local, 'p1/a.txt', 'a');
  await first.flush();
  await first.erase();
  await first.flush();
  assert.deepEqual(await tree(first.local), {});
  assert.equal(await exists(join(durable, 'head.json')), false);
});

test('the profile record names the data directory, wherever the data is worked on', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-vault-record-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const env = { STM_DATA_DIR: join(root, 'manager'), STM_PROFILE_DATA_DIR: join(root, 'local-disk', 'profiles') };
  const paths = getPlatformPaths({ platform: 'linux', env, mountTable: null });
  const store = new ProfileStore({ paths, logger: () => undefined });
  const created = await store.create({ name: 'Main', installationId: 'install-1', runtimePath: join(root, 'runtime') }, true);
  assert.equal(created.dataPath, join(paths.profileData, created.id, 'data'));
  const recorded = JSON.parse(await readFile(join(paths.state, 'profiles.json'), 'utf8')) as { profiles: Array<{ dataPath: string; configPath: string }> };
  assert.equal(recorded.profiles[0]?.dataPath, join(paths.profiles, '.profile-data', created.id, 'data'));
  assert.equal(recorded.profiles[0]?.configPath, join(paths.profiles, '.profile-data', created.id, 'config.yaml'));

  const reread = new ProfileStore({ paths, logger: () => undefined });
  assert.equal((await reread.getActive())?.dataPath, created.dataPath);
  // The same record on a machine that keeps the data in the data directory.
  const plain = new ProfileStore({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: env.STM_DATA_DIR }, mountTable: null }), logger: () => undefined });
  assert.equal((await plain.getActive())?.dataPath, join(paths.profiles, '.profile-data', created.id, 'data'));
});
