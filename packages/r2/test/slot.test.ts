import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DriveObjectStore } from '../src/drive-store.js';
import { S3ObjectStore } from '../src/s3.js';
import { claimSlot, readSlot } from '../src/slot.js';
import { R2HttpError, type ObjectRecord, type ObjectStore } from '../src/store.js';
import { fakeGoogle, type FakeGoogle } from './google-fake.js';

const KEY = 'sillytavern-manager/sync/gen/0000000007.json';
const quick = { settleMs: 5, stallMs: 1000, sleep: async (): Promise<void> => undefined };

/** A bucket in memory. `refuses` makes it one that can turn a second write away itself. */
function memoryStore(options: { refuses?: boolean } = {}): ObjectStore & { objects: Map<string, Buffer>; puts: number } {
  const objects = new Map<string, Buffer>();
  const store: ObjectStore & { objects: Map<string, Buffer>; puts: number } = {
    objects,
    puts: 0,
    async listObjects(prefix: string): Promise<{ objects: ObjectRecord[]; cursor: undefined }> {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key, sizeBytes: objects.get(key)?.byteLength ?? 0, lastModified: null, etag: null })), cursor: undefined };
    },
    async putObject(key: string, body: Uint8Array): Promise<void> { store.puts += 1; objects.set(key, Buffer.from(body)); },
    async getObject(key: string): Promise<Buffer> {
      const found = objects.get(key);
      if (!found) throw new R2HttpError(404, 'no such key');
      return found;
    },
    async deleteObject(key: string): Promise<void> { objects.delete(key); },
  };
  if (options.refuses) {
    store.putIfAbsent = async (key: string, body: Uint8Array): Promise<boolean> => {
      if (objects.has(key)) return false;
      objects.set(key, Buffer.from(body));
      return true;
    };
  }
  return store;
}

const attempt = (device: string): Buffer => Buffer.from(JSON.stringify({ device, nonce: randomBytes(6).toString('hex') }));

test('the first writer takes a slot and the next one is told who holds it', async () => {
  for (const refuses of [false, true]) {
    const store = memoryStore({ refuses });
    const phone = attempt('phone');
    const first = await claimSlot(store, KEY, phone, quick);
    assert.equal(first.won, true);
    assert.deepEqual(first.holder, phone);
    const second = await claimSlot(store, KEY, attempt('pc'), quick);
    assert.equal(second.won, false);
    assert.deepEqual(second.holder, phone);
    assert.deepEqual(await readSlot(store, KEY), phone);
  }
});

test('nothing in a slot reads as nothing, and any other failure is not hidden', async () => {
  const store = memoryStore();
  assert.equal(await readSlot(store, KEY), null);
  store.getObject = async (): Promise<Buffer> => { throw new R2HttpError(500, 'broken'); };
  await assert.rejects(readSlot(store, KEY), /broken/u);
});

test('two writers that both found the slot empty end up agreeing on one of them', async () => {
  // The pause between writing and looking again is where the second write lands.
  const store = memoryStore();
  const phone = attempt('phone');
  const pc = attempt('pc');
  let release: () => void = () => undefined;
  const bothWritten = new Promise<void>((resolve) => { release = resolve; });
  let waiting = 0;
  const sleep = async (): Promise<void> => { waiting += 1; if (waiting === 2) release(); await bothWritten; };
  const [a, b] = await Promise.all([claimSlot(store, KEY, phone, { ...quick, sleep }), claimSlot(store, KEY, pc, { ...quick, sleep })]);
  assert.equal(store.puts, 2);
  assert.equal([a.won, b.won].filter(Boolean).length, 1);
  assert.deepEqual(a.holder, b.holder);
});

test('a bucket that refuses a second write never lets it land', async () => {
  const store = memoryStore({ refuses: true });
  const [a, b] = await Promise.all([claimSlot(store, KEY, attempt('phone'), quick), claimSlot(store, KEY, attempt('pc'), quick)]);
  assert.equal([a.won, b.won].filter(Boolean).length, 1);
  assert.deepEqual(a.holder, b.holder);
  assert.equal(store.objects.size, 1);
});

test('the S3 store asks the bucket to refuse a key that is taken', async () => {
  const seen: Array<{ method: string; ifNoneMatch: string | null }> = [];
  let status = 200;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ method: init?.method ?? 'GET', ifNoneMatch: new Headers(init?.headers).get('if-none-match') });
    return new Response(status === 200 ? '' : '<Error><Code>PreconditionFailed</Code></Error>', { status });
  }) as typeof fetch;
  const store = new S3ObjectStore({ endpoint: 'https://bucket.example.invalid', bucket: 'b', accessKeyId: 'id', secretAccessKey: 'secret' }, fetchImpl, () => undefined);
  assert.equal(await store.putIfAbsent(KEY, Buffer.from('x'), 'application/json'), true);
  status = 412;
  assert.equal(await store.putIfAbsent(KEY, Buffer.from('y'), 'application/json'), false);
  status = 403;
  await assert.rejects(store.putIfAbsent(KEY, Buffer.from('z'), 'application/json'), /403/u);
  assert.deepEqual(seen.map((entry) => entry.ifNoneMatch), ['*', '*', '*']);
});

const BROKER = 'https://broker.example';

async function driveStore(fake: FakeGoogle): Promise<DriveObjectStore> {
  const verifier = randomBytes(32).toString('base64url');
  const code = fake.issueCode(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const response = await fake.fetchImpl(`${BROKER}/api/google/token`, { method: 'POST', body: JSON.stringify({ code, code_verifier: verifier }) });
  const token = (await response.json() as { access_token: string }).access_token;
  return new DriveObjectStore({ token: async () => token, invalidate: () => undefined, ready: async () => undefined, fetchImpl: fake.fetchImpl, sleep: async () => undefined });
}

function slotFiles(fake: FakeGoogle): string[] {
  return [...fake.files.values()].filter((file) => file.name === KEY).map((file) => file.content.toString('utf8'));
}

test('on Drive the first writer takes the slot and a later one creates nothing', async () => {
  const fake = fakeGoogle();
  const phoneStore = await driveStore(fake);
  const pcStore = await driveStore(fake);
  const phone = attempt('phone');
  const first = await claimSlot(phoneStore, KEY, phone, quick);
  assert.equal(first.won, true);
  const creates = fake.calls.create;
  const second = await claimSlot(pcStore, KEY, attempt('pc'), quick);
  assert.equal(second.won, false);
  assert.deepEqual(second.holder, phone);
  assert.equal(fake.calls.create, creates);
  assert.deepEqual(await readSlot(pcStore, KEY), phone);
  assert.equal(await readSlot(pcStore, 'sillytavern-manager/sync/gen/0000000008.json'), null);
});

test('on Drive two files under one name are settled by the time Drive stamped, not by who asked', async () => {
  const fake = fakeGoogle();
  const phoneStore = await driveStore(fake);
  const pcStore = await driveStore(fake);
  const phone = attempt('phone');
  const pc = attempt('pc');
  // Both found the slot empty and both created; both are waiting to look again.
  let release: () => void = () => undefined;
  const bothCreated = new Promise<void>((resolve) => { release = resolve; });
  let waiting = 0;
  const sleep = async (): Promise<void> => {
    waiting += 1;
    if (waiting === 2) {
      // Drive stamped the file that was sent second as the earlier one.
      const files = [...fake.files.values()].filter((file) => file.name === KEY);
      assert.equal(files.length, 2);
      const [early, late] = ['2026-11-16T07:44:19.197Z', '2026-11-16T07:44:19.201Z'];
      for (const file of files) file.createdTime = file.content.equals(pc) ? early : late;
      release();
    }
    await bothCreated;
  };
  const [a, b] = await Promise.all([claimSlot(phoneStore, KEY, phone, { ...quick, sleep }), claimSlot(pcStore, KEY, pc, { ...quick, sleep })]);
  assert.equal(a.won, false);
  assert.equal(b.won, true);
  assert.deepEqual(a.holder, pc);
  assert.deepEqual(b.holder, pc);
  // One file is left, so every later reader has one answer.
  assert.deepEqual(slotFiles(fake), [pc.toString('utf8')]);
  assert.deepEqual(await readSlot(phoneStore, KEY), pc);
});

test('on Drive a create that was held up withdraws instead of claiming the slot', async () => {
  const fake = fakeGoogle();
  const store = await driveStore(fake);
  let clock = 0;
  // The create is the only thing between the two readings of the clock.
  const result = await claimSlot(store, KEY, attempt('phone'), { settleMs: 5, stallMs: 1000, sleep: async () => undefined, now: () => (clock += 5000) });
  assert.equal(result.won, false);
  assert.equal(result.holder, null);
  assert.deepEqual(slotFiles(fake), []);
});

test('on Drive a create that was sent twice leaves one file for the writer that won', async () => {
  const fake = fakeGoogle();
  const store = await driveStore(fake);
  const phone = attempt('phone');
  // The first send landed although the caller gave up on it, so there are two.
  let duplicated = false;
  const sleep = async (): Promise<void> => {
    if (duplicated) return;
    duplicated = true;
    const [original] = [...fake.files.values()].filter((file) => file.name === KEY);
    assert.ok(original);
    fake.files.set('f-duplicate', { ...original, id: 'f-duplicate', createdTime: '2099-01-01T00:00:00.000Z' });
  };
  const result = await claimSlot(store, KEY, phone, { ...quick, sleep });
  assert.equal(result.won, true);
  assert.deepEqual(slotFiles(fake), [phone.toString('utf8')]);
});
