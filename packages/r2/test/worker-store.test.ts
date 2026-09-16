import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKER_KEY_SETTLE_MS, type WorkerSession } from '../../cloudflare/src/index.js';
import { loadWorker, MemoryBucket, workerFetch } from '../../cloudflare/test/worker-harness.js';
import { R2HttpError, type Billing } from '../src/store.js';
import { WorkerObjectStore } from '../src/worker-store.js';

function session(overrides: Partial<WorkerSession> = {}): WorkerSession {
  return { baseUrl: 'https://sillytavern-manager-backup.acme.workers.dev', keyId: 'install0001', key: 'k'.repeat(43), issuedAt: Date.now() - WORKER_KEY_SETTLE_MS - 1, expiresAt: Date.now() + 60_000, rotateAt: Date.now() + 30_000, ...overrides };
}

async function setup(current: () => WorkerSession = () => session()): Promise<{ store: WorkerObjectStore; bucket: MemoryBucket; billed: Billing[]; env: Record<string, unknown> }> {
  const bucket = new MemoryBucket();
  const first = current();
  const env: Record<string, unknown> = { BUCKET: bucket, [`STM_KEY_${first.keyId}`]: `${first.expiresAt}.${first.key}` };
  const billed: Billing[] = [];
  const store = new WorkerObjectStore({ session: async () => current(), onRequest: (billing) => billed.push(billing), fetchImpl: workerFetch(await loadWorker(), env) });
  return { store, bucket, billed, env };
}

test('the manager\'s requests are accepted by the Worker it deploys, end to end', async () => {
  const { store, bucket, billed } = await setup();
  const chunk = new Uint8Array(4 * 1024 * 1024).map((_, index) => index % 251);
  await store.putObject('sillytavern-manager/blobs/ab/abcdef', chunk, 'application/octet-stream');
  await store.putObject('sillytavern-manager/snapshots/p 1/2026.json.gz', new Uint8Array([5]), 'application/gzip');
  assert.equal(bucket.objects.get('sillytavern-manager/snapshots/p 1/2026.json.gz')?.contentType, 'application/gzip');
  assert.ok((await store.getObject('sillytavern-manager/blobs/ab/abcdef')).equals(Buffer.from(chunk)));

  const first = await store.listObjects('sillytavern-manager/', 1);
  assert.equal(first.objects[0]?.key, 'sillytavern-manager/blobs/ab/abcdef');
  assert.equal(first.objects[0]?.sizeBytes, chunk.byteLength);
  const second = await store.listObjects('sillytavern-manager/', 1, first.cursor);
  assert.equal(second.objects[0]?.key, 'sillytavern-manager/snapshots/p 1/2026.json.gz');
  assert.equal(second.cursor, undefined);

  await store.deleteObject('sillytavern-manager/blobs/ab/abcdef');
  assert.equal(bucket.objects.has('sillytavern-manager/blobs/ab/abcdef'), false);
  assert.deepEqual(billed, ['charged', 'charged', 'read', 'charged', 'charged', 'free']);
});

test('a rotated session is picked up on the next request', async () => {
  let current = session();
  const { store, env } = await setup(() => current);
  await store.putObject('sillytavern-manager/a', new Uint8Array([1]), 'application/octet-stream');
  const next = session({ key: 'n'.repeat(43) });
  env.STM_KEY_install0001 = `${next.expiresAt}.${next.key}`;
  current = next;
  assert.deepEqual([...(await store.getObject('sillytavern-manager/a'))], [1]);
});

test('a new key refused by an edge that has not caught up is tried again, and counted once', async () => {
  const bucket = new MemoryBucket();
  const fresh = session({ issuedAt: Date.now() });
  const env = { BUCKET: bucket, STM_KEY_install0001: `${fresh.expiresAt}.${fresh.key}` };
  const reach = workerFetch(await loadWorker(), env);
  let refusals = 2;
  const edge: typeof fetch = async (input, init) => (refusals-- > 0 ? Response.json({ error: 'unauthorized' }, { status: 401 }) : await reach(input, init));
  const slept: number[] = [];
  const billed: Billing[] = [];
  const store = new WorkerObjectStore({ session: async () => fresh, onRequest: (billing) => billed.push(billing), fetchImpl: edge, sleep: async (milliseconds) => { slept.push(milliseconds); } });
  await store.putObject('sillytavern-manager/a', new Uint8Array([1]), 'application/octet-stream');
  assert.deepEqual(slept, [1_000, 2_000]);
  assert.deepEqual(billed, ['charged']);
  assert.equal(bucket.objects.size, 1);
});

test('a request refused because the key was rotated meanwhile is signed again with the new key', async () => {
  const bucket = new MemoryBucket();
  const old = session({ key: 'o'.repeat(43) });
  const next = session({ key: 'n'.repeat(43) });
  const env: Record<string, unknown> = { BUCKET: bucket, STM_KEY_install0001: `${next.expiresAt}.${next.key}` };
  let current = old;
  const reach = workerFetch(await loadWorker(), env);
  const slept: number[] = [];
  const store = new WorkerObjectStore({
    // The first request is signed with the old key; by the time it is refused, rotation has happened.
    session: async () => { const handed = current; current = next; return handed; },
    onRequest: () => undefined,
    fetchImpl: reach,
    sleep: async (milliseconds) => { slept.push(milliseconds); },
  });
  await store.putObject('sillytavern-manager/a', new Uint8Array([1]), 'application/octet-stream');
  assert.equal(bucket.objects.size, 1);
  assert.deepEqual(slept, []);
});

test('a refusal of a key past its settling time is not retried', async () => {
  const slept: number[] = [];
  const store = new WorkerObjectStore({
    session: async () => session(),
    onRequest: () => undefined,
    fetchImpl: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    sleep: async (milliseconds) => { slept.push(milliseconds); },
  });
  await assert.rejects(store.getObject('sillytavern-manager/a'), (error: unknown) => error instanceof R2HttpError && error.status === 401);
  assert.deepEqual(slept, []);
});

test('a refused or missing object is an HTTP error naming the reason', async () => {
  const { store } = await setup();
  await assert.rejects(store.getObject('sillytavern-manager/none'), (error: unknown) => error instanceof R2HttpError && error.status === 404 && /not_found/u.test(error.message));
  await assert.rejects(store.putObject('elsewhere/x', new Uint8Array([1]), 'application/octet-stream'), (error: unknown) => error instanceof R2HttpError && error.status === 403 && /forbidden_key/u.test(error.message));
  let current = session();
  const { store: stale } = await setup(() => current);
  current = session({ key: 'a key the Worker was never given' });
  await assert.rejects(stale.getObject('sillytavern-manager/a'), (error: unknown) => error instanceof R2HttpError && error.status === 401);
});
