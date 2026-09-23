import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupError, BackupStore, isJunk } from '../../../packages/backup/src/index.js';
import type { Profile } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { capacityOf, checkFits, decideTrim, memoryGuard, RESTORE_FLOOR_BYTES, RESTORE_RESERVE_BYTES, roomCheck, type Headroom } from '../src/headroom.js';

const MB = 1_000_000;

function room(bytes: number): () => Promise<Headroom> {
  return async () => ({ memoryBytes: bytes, diskBytes: null, bytes });
}

async function world(name: string): Promise<{ profile: Profile; dataRoot: string; store: BackupStore }> {
  const root = await mkdtemp(join(tmpdir(), `stm-headroom-${name}-`));
  const runtimePath = join(root, 'runtime');
  const dataRoot = join(runtimePath, 'data', 'default-user');
  await mkdir(dataRoot, { recursive: true });
  const now = new Date().toISOString();
  const profile: Profile = { id: name, name: 'Default', installationId: 'i', runtimePath, configPath: join(runtimePath, 'config.yaml'), dataPath: join(runtimePath, 'data'), layout: 'data', active: true, createdAt: now, updatedAt: now, activatedAt: now };
  return { profile, dataRoot, store: new BackupStore({ paths: getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } }), logger: () => undefined }) };
}

async function put(root: string, name: string, bytes: number): Promise<void> {
  await mkdir(join(root, name, '..'), { recursive: true });
  await writeFile(join(root, name), Buffer.alloc(bytes, 'x'));
}

test('junk is what SillyTavern can do without, and nothing the reader would miss', () => {
  for (const name of ['extensions/JS-Slash-Runner/.git/objects/pack/pack-1.pack', 'extensions/x/node_modules/a/index.js', 'backups/settings_2026.json', 'thumbnails/bg/a.png', 'vectors/chat/index.json', '_cache/a', 'extensions/x/.github/workflows/ci.yml']) {
    assert.equal(isJunk(name), true, name);
  }
  for (const name of ['chats/Alice/2026.jsonl', 'characters/Alice.png', 'worlds/Genshin.json', 'OpenAI Settings/Preset.json', 'settings.json', 'secrets.json', 'extensions/JS-Slash-Runner/dist/index.js', 'extensions/x/manifest.json', 'backups', 'user/files/backups.json']) {
    assert.equal(isJunk(name), false, name);
  }
});

test('what fits is measured net of what a replace frees, and less what SillyTavern needs to run', () => {
  const headroom = { memoryBytes: 0, diskBytes: null, bytes: RESTORE_RESERVE_BYTES + 1000 * MB };
  const fitsWhole = capacityOf({ incomingBytes: 1500 * MB, junkBytes: 200 * MB, junkFiles: 10, freedBytes: 600 * MB }, headroom);
  assert.equal(fitsWhole.availableBytes, 1000 * MB);
  assert.equal(fitsWhole.neededBytes, 900 * MB);
  assert.equal(fitsWhole.fits, true);
  const onlyTrimmed = capacityOf({ incomingBytes: 1500 * MB, junkBytes: 600 * MB, junkFiles: 10, freedBytes: 0 }, headroom);
  assert.deepEqual([onlyTrimmed.fits, onlyTrimmed.fitsTrimmed], [false, true]);
  const neither = capacityOf({ incomingBytes: 3000 * MB, junkBytes: 100 * MB, junkFiles: 1, freedBytes: 0 }, headroom);
  assert.deepEqual([neither.fits, neither.fitsTrimmed], [false, false]);
});

test('an archive too large whole is restored without its junk, and a replace clears the profile’s own', async () => {
  const source = await world('source');
  await put(source.dataRoot, 'settings.json', 1000);
  await put(source.dataRoot, 'chats/a.jsonl', 3 * MB);
  await put(source.dataRoot, 'extensions/ext/index.js', 1000);
  await put(source.dataRoot, 'extensions/ext/.git/objects/pack/p.pack', 4 * MB);
  await put(source.dataRoot, 'backups/settings_old.json', 1 * MB);
  const archivePath = (await source.store.getArchivePath((await source.store.create(source.profile)).id))!;

  const target = await world('target');
  target.store.saving = true;
  await put(target.dataRoot, 'thumbnails/old.png', 2 * MB);
  const estimate = await target.store.estimate(target.profile, { archivePath }, 'replace');
  assert.equal(estimate.junkFiles, 2);
  assert.equal(estimate.junkBytes, 5 * MB);
  assert.equal(estimate.freedBytes, 2 * MB);

  // A machine with room for the chats but not for the git history.
  const machine = room(RESTORE_RESERVE_BYTES + 3 * MB);
  await assert.rejects(() => checkFits(target.store, target.profile, { archivePath }, 'replace', false, machine), (error: unknown) => error instanceof BackupError && error.code === 'restore_too_large');
  await checkFits(target.store, target.profile, { archivePath }, 'replace', true, machine);
  assert.deepEqual(await decideTrim(target.store, target.profile, { archivePath }, 'replace', machine).then((fit) => fit?.trim), true);
  assert.equal(await decideTrim(target.store, target.profile, { archivePath }, 'replace', room(RESTORE_RESERVE_BYTES)), null);

  await target.store.restore(target.profile, archivePath, { mode: 'replace', trim: true });
  assert.equal((await readFile(join(target.dataRoot, 'chats', 'a.jsonl'))).length, 3 * MB);
  assert.equal((await readFile(join(target.dataRoot, 'extensions', 'ext', 'index.js'))).length, 1000);
  await assert.rejects(() => readFile(join(target.dataRoot, 'extensions', 'ext', '.git', 'objects', 'pack', 'p.pack')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(join(target.dataRoot, 'backups', 'settings_old.json')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(join(target.dataRoot, 'thumbnails', 'old.png')), { code: 'ENOENT' });
});

test('a machine running out mid-restore stops the restore before it runs out', async () => {
  const source = await world('guard-source');
  for (let index = 0; index < 30; index += 1) await put(source.dataRoot, `chats/c${index}.jsonl`, 1000);
  const archivePath = (await source.store.getArchivePath((await source.store.create(source.profile)).id))!;
  const target = await world('guard-target');
  let looks = 0;
  // The machine is already down to the last of its room when the restore
  // looks: something else - SillyTavern, a log - took what the estimate saw.
  const guard = memoryGuard(target.profile.dataPath, async () => { looks += 1; const left = RESTORE_FLOOR_BYTES - MB; return { memoryBytes: left, diskBytes: null, bytes: left }; });
  await assert.rejects(() => target.store.restore(target.profile, archivePath, { mode: 'merge', checkpoint: guard }), (error: unknown) => error instanceof BackupError && error.code === 'restore_out_of_memory');
  // Once tripped, it keeps saying so.
  await assert.rejects(guard, (error: unknown) => error instanceof BackupError && error.code === 'restore_out_of_memory');
  assert.ok((await readdir(join(target.dataRoot, 'chats')).catch(() => [])).length < 30, 'it stopped before writing everything');
  // Eight writers asked at once and shared one look.
  assert.equal(looks, 1);
});

test('a replace counts every file it frees, however many are read at once', async () => {
  const source = await world('count-source');
  await put(source.dataRoot, 'settings.json', 10);
  const archivePath = (await source.store.getArchivePath((await source.store.create(source.profile)).id))!;
  const target = await world('count-target');
  for (let index = 0; index < 40; index += 1) await put(target.dataRoot, `chats/c${index}.jsonl`, 1000 + index);
  await put(target.dataRoot, 'settings.json', 500);
  const expected = Array.from({ length: 40 }, (_, index) => 1000 + index).reduce((sum, size) => sum + size, 0) + 500;
  assert.equal((await target.store.estimate(target.profile, { archivePath }, 'replace')).freedBytes, expected);
  // A merge frees only what it overwrites.
  assert.equal((await target.store.estimate(target.profile, { archivePath }, 'merge')).freedBytes, 500);
});

test('with the old files gone the room is measured again, and a restore it does not fit writes nothing', async () => {
  const source = await world('recheck-source');
  await put(source.dataRoot, 'settings.json', 1000);
  await put(source.dataRoot, 'chats/new.jsonl', 3 * MB);
  const archivePath = (await source.store.getArchivePath((await source.store.create(source.profile)).id))!;

  const target = await world('recheck-target');
  target.store.saving = true;
  await put(target.dataRoot, 'chats/old.jsonl', 5 * MB);
  await put(target.dataRoot, 'settings.json', 400);
  // Asked with what is left to write: the archive less the file it writes over.
  const asked: number[] = [];
  await target.store.restore(target.profile, archivePath, { mode: 'replace', recheck: async (needed) => { asked.push(needed); } });
  assert.deepEqual(asked, [3 * MB + 1000 - 400]);

  // A host whose deleted files have not given their memory back yet.
  await rm(join(target.dataRoot, 'chats', 'new.jsonl'));
  await put(target.dataRoot, 'chats/old.jsonl', 5 * MB);
  let looks = 0;
  const stuck = roomCheck(target.profile.dataPath, async () => { looks += 1; return { memoryBytes: RESTORE_RESERVE_BYTES + MB, diskBytes: null, bytes: RESTORE_RESERVE_BYTES + MB }; }, { attempts: 3, intervalMs: 1 });
  await assert.rejects(() => target.store.restore(target.profile, archivePath, { mode: 'replace', recheck: stuck }), (error: unknown) => error instanceof BackupError && error.code === 'restore_too_large');
  assert.equal(looks, 3, 'it waited for the room to come back before giving up');
  await assert.rejects(() => readFile(join(target.dataRoot, 'chats', 'new.jsonl')), { code: 'ENOENT' });

  // And one whose memory comes back a moment later goes ahead.
  let later = 0;
  const settling = roomCheck(target.profile.dataPath, async () => { later += 1; const bytes = RESTORE_RESERVE_BYTES + (later < 3 ? MB : 10 * MB); return { memoryBytes: bytes, diskBytes: null, bytes }; }, { attempts: 5, intervalMs: 1 });
  await target.store.restore(target.profile, archivePath, { mode: 'replace', recheck: settling });
  assert.equal((await readFile(join(target.dataRoot, 'chats', 'new.jsonl'))).length, 3 * MB);
  assert.equal(later, 3);
});
