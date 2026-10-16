import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DriveObjectStore } from '../src/drive-store.js';
import { fakeGoogle, type FakeGoogle } from './google-fake.js';

const BROKER = 'https://broker.example';

/** An access token for the fake's default account, the way a sign-in gets one. */
async function accessToken(fake: FakeGoogle): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const code = fake.issueCode(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const response = await fake.fetchImpl(`${BROKER}/api/google/token`, { method: 'POST', body: JSON.stringify({ code, code_verifier: verifier }) });
  return (await response.json() as { access_token: string }).access_token;
}

async function store(fake: FakeGoogle, options: { packTargetBytes?: number; soloMinBytes?: number; stallBaseMs?: number } = {}): Promise<DriveObjectStore> {
  const token = await accessToken(fake);
  return new DriveObjectStore({
    token: async () => token,
    invalidate: () => undefined,
    ready: async () => undefined,
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
    packTargetBytes: options.packTargetBytes ?? 1000,
    soloMinBytes: options.soloMinBytes ?? 400,
    ...(options.stallBaseMs === undefined ? {} : { stallBaseMs: options.stallBaseMs }),
  });
}

const chunkKey = (index: number): string => `sillytavern-manager/blobs/${String(index).padStart(2, '0')}/${String(index).padStart(64, '0')}`;
const body = (index: number, size = 100): Buffer => Buffer.alloc(size, index);

async function listAll(target: DriveObjectStore, prefix = 'sillytavern-manager/'): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await target.listObjects(prefix, 5, cursor);
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

function driveNames(fake: FakeGoogle): string[] {
  return [...fake.files.values()].map((file) => file.name).sort();
}

test('small chunks travel in packs, a large one alone, and a new machine finds them all', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake);
  for (let index = 0; index < 25; index += 1) await desk.putObject(chunkKey(index), body(index), 'application/octet-stream');
  await desk.putObject(chunkKey(99), body(99, 500), 'application/octet-stream');
  // The large one went at once; the rest wait for flush beyond the full packs.
  await desk.flush();
  const names = driveNames(fake);
  assert.equal(names.filter((name) => name.startsWith('stm-packs/')).length, 3);
  assert.deepEqual(names.filter((name) => !name.startsWith('stm-packs/')), [chunkKey(99)]);

  const laptop = await store(fake);
  const keys = await listAll(laptop);
  assert.equal(keys.length, 26);
  assert.ok(keys.every((key) => key.startsWith('sillytavern-manager/blobs/')), 'packs never show in a listing');
  for (const index of [0, 13, 24, 99]) assert.deepEqual(await laptop.getObject(chunkKey(index)), body(index, index === 99 ? 500 : 100));

  // Neighbours come from the pack already read, not from Drive again.
  const downloads = fake.calls.download;
  await laptop.getObject(chunkKey(1));
  await laptop.getObject(chunkKey(2));
  assert.equal(fake.calls.download, downloads);
});

test('anything that is not a chunk waits for the chunks before it', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake);
  await desk.putObject(chunkKey(1), body(1), 'application/octet-stream');
  await desk.putObject(chunkKey(2), body(2), 'application/octet-stream');
  assert.equal(fake.files.size, 0);
  await desk.putObject('sillytavern-manager/snapshots/p/one.json.gz', Buffer.from('index'), 'application/gzip');
  const names = driveNames(fake);
  assert.equal(names.length, 2);
  assert.ok(names.some((name) => name.startsWith('stm-packs/')));
  assert.ok(names.includes('sillytavern-manager/snapshots/p/one.json.gz'));
});

test('a lone chunk is not worth a pack', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake);
  await desk.putObject(chunkKey(7), body(7), 'application/octet-stream');
  await desk.flush();
  assert.deepEqual(driveNames(fake), [chunkKey(7)]);
  // Named by content: the same chunk again sends nothing.
  await desk.putObject(chunkKey(7), body(7), 'application/octet-stream');
  await desk.flush();
  assert.equal(fake.calls.create, 1);
});

test('a pack Drive refused fails the flush, so its chunks are never recorded as stored', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake);
  fake.failNext(400, 1, 'badRequest');
  await desk.putObject(chunkKey(1), body(1), 'application/octet-stream');
  await desk.putObject(chunkKey(2), body(2), 'application/octet-stream');
  await assert.rejects(desk.flush(), /400/u);
  assert.equal(fake.files.size, 0);
  // Said once: the next run starts clean.
  await desk.flush();
});

test('deleting from a pack frees it when the last chunk goes, and compact rewrites mostly empty ones', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake);
  for (let index = 0; index < 20; index += 1) await desk.putObject(chunkKey(index), body(index), 'application/octet-stream');
  await desk.flush();
  assert.equal(driveNames(fake).filter((name) => name.startsWith('stm-packs/')).length, 2);

  // The first pack holds 0-9: all of it goes, and the pack with it.
  for (let index = 0; index < 10; index += 1) await desk.deleteObject(chunkKey(index));
  assert.equal(driveNames(fake).filter((name) => name.startsWith('stm-packs/')).length, 1);

  // Most of the second goes; its bytes stay until compact.
  for (let index = 10; index < 17; index += 1) await desk.deleteObject(chunkKey(index));
  const before = [...fake.files.values()].find((file) => file.name.startsWith('stm-packs/'))!;
  const result = await desk.compact();
  assert.equal(result.rewrittenPacks, 1);
  const packs = [...fake.files.values()].filter((file) => file.name.startsWith('stm-packs/'));
  assert.equal(packs.length, 1);
  assert.notEqual(packs[0]!.id, before.id);
  assert.ok(packs[0]!.content.byteLength < before.content.byteLength / 2);

  const laptop = await store(fake);
  assert.deepEqual((await listAll(laptop)).sort(), [chunkKey(17), chunkKey(18), chunkKey(19)]);
  assert.deepEqual(await laptop.getObject(chunkKey(18)), body(18));
});

test('compact gathers the small packs and single chunks frequent backups leave behind', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake, { packTargetBytes: 10_000 });
  // Sixteen runs: a lone chunk each, then two chunks each.
  for (let index = 0; index < 8; index += 1) {
    await desk.putObject(chunkKey(index), body(index), 'application/octet-stream');
    await desk.flush();
  }
  for (let index = 8; index < 24; index += 2) {
    await desk.putObject(chunkKey(index), body(index), 'application/octet-stream');
    await desk.putObject(chunkKey(index + 1), body(index + 1), 'application/octet-stream');
    await desk.flush();
  }
  assert.equal(fake.files.size, 16);
  const result = await desk.compact();
  assert.equal(result.gatheredFiles, 16);
  assert.equal(fake.files.size, 1);
  const laptop = await store(fake);
  assert.equal((await listAll(laptop)).length, 24);
  for (let index = 0; index < 24; index += 1) assert.deepEqual(await laptop.getObject(chunkKey(index)), body(index));
});

test('a reader whose listing is older than a rewrite finds the chunk in the new pack', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake);
  for (let index = 0; index < 10; index += 1) await desk.putObject(chunkKey(index), body(index), 'application/octet-stream');
  await desk.flush();
  const laptop = await store(fake);
  await listAll(laptop);
  for (let index = 0; index < 8; index += 1) await desk.deleteObject(chunkKey(index));
  await desk.compact();
  assert.deepEqual(await laptop.getObject(chunkKey(9)), body(9));
});

test('an upload Drive sits on is given up and sent again', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake, { stallBaseMs: 20 });
  fake.hangNext(1);
  await desk.putObject(chunkKey(99), body(99, 500), 'application/octet-stream');
  assert.deepEqual(driveNames(fake), [chunkKey(99)]);
  const laptop = await store(fake);
  assert.deepEqual(await laptop.getObject(chunkKey(99)), body(99, 500));
});

test('deleting everything empties the app folder', async () => {
  const fake = fakeGoogle();
  const desk = await store(fake);
  for (let index = 0; index < 12; index += 1) await desk.putObject(chunkKey(index), body(index), 'application/octet-stream');
  await desk.putObject('sillytavern-manager/owner.json', Buffer.from('{}'), 'application/json');
  const used = await desk.storedBytes();
  assert.ok(used && used.files > 0 && used.bytes > 0);
  const removed = await desk.deleteEverything();
  assert.equal(removed.files, used.files);
  assert.equal(fake.files.size, 0);
});
