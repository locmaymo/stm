import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestPacer, RestObjectStore } from '../src/rest.js';
import { R2Error, R2HttpError, type Billing } from '../src/store.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const BUCKET = 'sillytavern-manager-backup';
const BASE = `/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects`;

/** A bucket behind the REST object endpoints, as far as the manager uses them. */
function fakeRest(options: { headers?: HeadersInit } = {}): { fetchImpl: typeof fetch; objects: Map<string, Buffer>; paths: string[]; tokens: string[] } {
  const objects = new Map<string, Buffer>();
  const paths: string[] = [];
  const tokens: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    const method = init?.method ?? 'GET';
    tokens.push(new Headers(init?.headers as HeadersInit).get('authorization') ?? '');
    paths.push(`${method} ${url.pathname}`);
    const headers = options.headers ?? {};
    if (url.pathname === BASE && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const perPage = Number(url.searchParams.get('per_page'));
      const matching = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : 0;
      const page = matching.slice(start, start + perPage);
      const truncated = start + page.length < matching.length;
      return Response.json({
        success: true, errors: [], messages: [],
        result: page.map((key) => ({ key, size: objects.get(key)?.byteLength, etag: 'abc', last_modified: '2026-09-16T00:00:00Z' })),
        result_info: { is_truncated: truncated, cursor: truncated ? String(start + page.length) : '' },
      }, { headers });
    }
    const key = decodeURIComponent(url.pathname.slice(BASE.length + 1));
    if (method === 'PUT') {
      objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer()));
      return Response.json({ success: true, errors: [], messages: [], result: { key } }, { headers });
    }
    if (method === 'GET') {
      const body = objects.get(key);
      return body ? new Response(new Uint8Array(body), { headers }) : Response.json({ success: false, errors: [{ code: 10007, message: 'The specified key does not exist.' }] }, { status: 404, headers });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return Response.json({ success: true, errors: [], messages: [], result: null }, { headers });
    }
    return new Response('', { status: 405 });
  };
  return { fetchImpl, objects, paths, tokens };
}

function store(fetchImpl: typeof fetch, billed: Billing[] = [], pacer?: RequestPacer): RestObjectStore {
  let token = 0;
  return new RestObjectStore({ accountId: ACCOUNT, bucket: BUCKET, accessToken: async () => `access-${++token}`, onRequest: (billing) => billed.push(billing), fetchImpl, ...(pacer ? { pacer } : {}) });
}

test('objects go up, come back byte for byte, list page by page and go away', async () => {
  const bucket = fakeRest();
  const billed: Billing[] = [];
  const objects = store(bucket.fetchImpl, billed);
  const body = new Uint8Array([0, 1, 2, 255]);
  await objects.putObject('sillytavern-manager/blobs/ab/abcd', body, 'application/octet-stream');
  await objects.putObject('sillytavern-manager/snapshots/p1/one.json.gz', new Uint8Array([9]), 'application/gzip');
  assert.deepEqual([...(await objects.getObject('sillytavern-manager/blobs/ab/abcd'))], [0, 1, 2, 255]);

  const first = await objects.listObjects('sillytavern-manager/', 1);
  assert.equal(first.objects.length, 1);
  assert.equal(first.objects[0]?.key, 'sillytavern-manager/blobs/ab/abcd');
  assert.equal(first.objects[0]?.sizeBytes, 4);
  const second = await objects.listObjects('sillytavern-manager/', 1, first.cursor);
  assert.equal(second.objects[0]?.key, 'sillytavern-manager/snapshots/p1/one.json.gz');
  assert.equal(second.cursor, undefined);

  await objects.deleteObject('sillytavern-manager/blobs/ab/abcd');
  assert.equal(bucket.objects.has('sillytavern-manager/blobs/ab/abcd'), false);
  assert.deepEqual(billed, ['charged', 'charged', 'read', 'charged', 'charged', 'free']);
  // A token is asked for on every request, so one refreshed meanwhile is used at once.
  assert.deepEqual(bucket.tokens.slice(0, 2), ['Bearer access-1', 'Bearer access-2']);
});

test('slashes in a key stay literal and the rest is percent-encoded', async () => {
  const bucket = fakeRest();
  await store(bucket.fetchImpl).putObject('sillytavern-manager/snapshots/p 1/a#b.json.gz', new Uint8Array([1]), 'application/gzip');
  assert.equal(bucket.paths[0], `PUT ${BASE}/sillytavern-manager/snapshots/p%201/a%23b.json.gz`);
});

test('a missing object is an HTTP error with Cloudflare\'s message', async () => {
  const bucket = fakeRest();
  await assert.rejects(store(bucket.fetchImpl).getObject('sillytavern-manager/blobs/none'), (error: unknown) => error instanceof R2HttpError && error.status === 404 && /does not exist/u.test(error.message));
});

test('a 429 stops the store and holds every later request until Cloudflare said to come back', async () => {
  let clock = 0;
  const slept: number[] = [];
  const pacer = new RequestPacer({ now: () => clock, sleep: async (milliseconds) => { slept.push(milliseconds); clock += milliseconds; } });
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '30' } }) : new Response(new Uint8Array([7])); };
  const objects = store(fetchImpl, [], pacer);
  await assert.rejects(objects.getObject('sillytavern-manager/x'), (error: unknown) => error instanceof R2Error && error.code === 'r2_rate_limited');
  assert.deepEqual([...(await objects.getObject('sillytavern-manager/x'))], [7]);
  assert.deepEqual(slept, [30_000]);
});

test('the pacer keeps to its budget per window', async () => {
  let clock = 0;
  const slept: number[] = [];
  const pacer = new RequestPacer({ budget: 3, windowMs: 1_000, now: () => clock, sleep: async (milliseconds) => { slept.push(milliseconds); clock += milliseconds; } });
  for (let request = 0; request < 3; request += 1) { await pacer.acquire(); clock += 100; }
  assert.deepEqual(slept, []);
  // The fourth has to wait for the first to leave the window: sent at 0, now 300.
  await pacer.acquire();
  assert.deepEqual(slept, [700]);
});

test('side-by-side callers cannot share one free slot', async () => {
  let clock = 0;
  const pacer = new RequestPacer({ budget: 2, windowMs: 1_000, now: () => clock, sleep: async (milliseconds) => { const wake = clock + milliseconds; await Promise.resolve(); clock = Math.max(clock, wake); } });
  const granted: number[] = [];
  await Promise.all([0, 1, 2, 3].map(async () => { await pacer.acquire(); granted.push(clock); }));
  assert.deepEqual(granted.sort((left, right) => left - right), [0, 0, 1_000, 1_000]);
});

test('a nearly spent limit reported by Cloudflare pauses until its window resets', async () => {
  let clock = 0;
  const slept: number[] = [];
  const pacer = new RequestPacer({ now: () => clock, sleep: async (milliseconds) => { slept.push(milliseconds); clock += milliseconds; } });
  const bucket = fakeRest({ headers: { ratelimit: '"default";r=40;t=12' } });
  const objects = store(bucket.fetchImpl, [], pacer);
  await objects.deleteObject('sillytavern-manager/a');
  assert.deepEqual(slept, []);
  await objects.deleteObject('sillytavern-manager/b');
  assert.deepEqual(slept, [12_000]);
});

test('an account ID or bucket that could reach another path is refused up front', () => {
  const fetchImpl: typeof fetch = async () => new Response('');
  assert.throws(() => new RestObjectStore({ accountId: '../user', bucket: BUCKET, accessToken: async () => 't', onRequest: () => undefined, fetchImpl }), (error: unknown) => error instanceof R2Error && error.code === 'invalid_r2_account');
  assert.throws(() => new RestObjectStore({ accountId: ACCOUNT, bucket: '../tokens', accessToken: async () => 't', onRequest: () => undefined, fetchImpl }), (error: unknown) => error instanceof R2Error && error.code === 'invalid_r2_bucket');
});
