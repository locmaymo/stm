import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKER_MAX_SKEW_MS, WORKER_VERSION } from '../src/worker-script.js';
import { signWorkerRequest } from '../src/workers.js';
import { loadWorker, MemoryBucket, type WorkerModule } from './worker-harness.js';

const BASE = 'https://sillytavern-manager-backup.example.workers.dev';
const SESSION = { keyId: 'install0001', key: 'k'.repeat(43) };

async function setup(stored: Record<string, string> = { STM_KEY_install0001: `${Date.now() + 60_000}.${SESSION.key}` }): Promise<{ worker: WorkerModule; env: Record<string, unknown>; bucket: MemoryBucket }> {
  const bucket = new MemoryBucket();
  return { worker: await loadWorker(), env: { BUCKET: bucket, ...stored }, bucket };
}

function signed(method: string, path: string, options: { session?: { keyId: string; key: string }; at?: number; body?: BodyInit } = {}): Request {
  const headers = signWorkerRequest(options.session ?? SESSION, method, path, options.at ?? Date.now());
  return new Request(`${BASE}${path}`, { method, headers, ...(options.body ? { body: options.body, duplex: 'half' } : {}) } as RequestInit);
}

test('a signed request reads the version', async () => {
  const { worker, env } = await setup();
  const response = await worker.fetch(signed('GET', '/v1/version'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: WORKER_VERSION });
});

test('objects under the prefix go up, come back and go away', async () => {
  const { worker, env, bucket } = await setup();
  const key = '/v1/o/sillytavern-manager/blobs/ab/abc';
  assert.equal((await worker.fetch(signed('PUT', key, { body: new Uint8Array([1, 2, 3]) }), env)).status, 200);
  assert.deepEqual([...(bucket.objects.get('sillytavern-manager/blobs/ab/abc')?.body ?? [])], [1, 2, 3]);
  const read = await worker.fetch(signed('GET', key), env);
  assert.deepEqual([...new Uint8Array(await read.arrayBuffer())], [1, 2, 3]);
  const listed = await (await worker.fetch(signed('GET', '/v1/list?prefix=sillytavern-manager%2F&limit=10'), env)).json() as { objects: Array<{ key: string; size: number }>; cursor: string | null };
  assert.deepEqual(listed.objects.map((entry) => [entry.key, entry.size]), [['sillytavern-manager/blobs/ab/abc', 3]]);
  assert.equal(listed.cursor, null);
  assert.equal((await worker.fetch(signed('DELETE', key), env)).status, 204);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await worker.fetch(signed('GET', key), env)).status, 404);
});

test('nothing outside the prefix can be touched or listed', async () => {
  const { worker, env } = await setup();
  assert.equal((await worker.fetch(signed('PUT', '/v1/o/other/file', { body: 'x' }), env)).status, 403);
  assert.equal((await worker.fetch(signed('GET', '/v1/o/sillytavern-manager/..%2F..%2Fother'), env)).status, 403);
  assert.equal((await worker.fetch(signed('GET', '/v1/list?prefix=other%2F'), env)).status, 403);
});

test('a wrong key, a wrong path, an old timestamp or an unknown installation is refused', async () => {
  const { worker, env } = await setup();
  assert.equal((await worker.fetch(signed('GET', '/v1/version', { session: { ...SESSION, key: 'wrong' } }), env)).status, 401);
  assert.equal((await worker.fetch(signed('GET', '/v1/version', { at: Date.now() - WORKER_MAX_SKEW_MS - 1_000 }), env)).status, 401);
  assert.equal((await worker.fetch(signed('GET', '/v1/version', { session: { ...SESSION, keyId: 'install0002' } }), env)).status, 401);
  // A signature for one request does not authorise another.
  const headers = signWorkerRequest(SESSION, 'GET', '/v1/version', Date.now());
  assert.equal((await worker.fetch(new Request(`${BASE}/v1/o/sillytavern-manager/x`, { method: 'DELETE', headers }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(`${BASE}/v1/version`), env)).status, 401);
});

test('an expired key stops working, and each installation keeps its own', async () => {
  const other = { keyId: 'install0002', key: 'o'.repeat(43) };
  const { worker, env } = await setup({
    STM_KEY_install0001: `${Date.now() - 1}.${SESSION.key}`,
    STM_KEY_install0002: `${Date.now() + 60_000}.${other.key}`,
  });
  assert.equal((await worker.fetch(signed('GET', '/v1/version'), env)).status, 401);
  assert.equal((await worker.fetch(signed('GET', '/v1/version', { session: other }), env)).status, 200);
});
