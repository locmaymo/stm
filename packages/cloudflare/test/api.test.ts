import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_BUCKET_NAME, CloudflareApi, CloudflareApiError, CloudflareRateLimitError, parseRateLimit, s3Endpoint } from '../src/api.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

interface Call { method: string; url: URL; headers: Headers; body: unknown }

function fakeApi(respond: (call: Call) => Response): { api: CloudflareApi; calls: Call[] } {
  const calls: Call[] = [];
  let token = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(input instanceof URL ? input.toString() : String(input)),
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  const api = new CloudflareApi({ accessToken: async () => `token-${++token}`, fetchImpl, now: () => 42 });
  return { api, calls };
}

function ok(result: unknown, resultInfo?: unknown, headers?: HeadersInit): Response {
  return Response.json({ success: true, errors: [], messages: [], result, ...(resultInfo === undefined ? {} : { result_info: resultInfo }) }, headers ? { headers } : {});
}

test('accounts are read page by page with a fresh bearer token each request', async () => {
  const { api, calls } = fakeApi(({ url }) => url.searchParams.get('page') === '1'
    ? ok([{ id: ACCOUNT, name: 'Personal' }], { page: 1, total_pages: 2 })
    : ok([{ id: 'fedcba9876543210fedcba9876543210', name: 'Team' }], { page: 2, total_pages: 2 }));
  assert.deepEqual(await api.listAccounts(), [{ id: ACCOUNT, name: 'Personal' }, { id: 'fedcba9876543210fedcba9876543210', name: 'Team' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url.pathname, '/client/v4/accounts');
  assert.equal(calls[0]?.headers.get('authorization'), 'Bearer token-1');
  assert.equal(calls[1]?.headers.get('authorization'), 'Bearer token-2');
});

test('buckets follow the cursor until it runs out', async () => {
  const { api, calls } = fakeApi(({ url }) => url.searchParams.get('cursor') === null
    ? ok({ buckets: [{ name: 'one', creation_date: '2026-01-01T00:00:00Z', location: 'APAC' }] }, { cursor: 'next' })
    : ok({ buckets: [{ name: 'two', jurisdiction: 'eu' }] }, { cursor: '' }));
  const buckets = await api.listBuckets(ACCOUNT, { nameContains: 'o' });
  assert.deepEqual(buckets, [
    { name: 'one', createdAt: '2026-01-01T00:00:00Z', location: 'APAC', jurisdiction: 'default' },
    { name: 'two', createdAt: null, location: null, jurisdiction: 'eu' },
  ]);
  assert.equal(calls[0]?.url.pathname, `/client/v4/accounts/${ACCOUNT}/r2/buckets`);
  assert.equal(calls[0]?.url.searchParams.get('name_contains'), 'o');
});

test('the backup bucket is found by exact name and not created again', async () => {
  const { api, calls } = fakeApi(() => ok({ buckets: [{ name: `${BACKUP_BUCKET_NAME}-old` }, { name: BACKUP_BUCKET_NAME }] }));
  const { bucket, created } = await api.ensureBackupBucket(ACCOUNT);
  assert.equal(bucket.name, BACKUP_BUCKET_NAME);
  assert.equal(created, false);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('a missing backup bucket is created as Standard storage', async () => {
  const { api, calls } = fakeApi(({ method }) => method === 'GET' ? ok({ buckets: [{ name: `${BACKUP_BUCKET_NAME}-old` }] }) : ok({ name: BACKUP_BUCKET_NAME, location: 'WEUR' }));
  const { bucket, created } = await api.ensureBackupBucket(ACCOUNT);
  assert.equal(created, true);
  assert.equal(bucket.location, 'WEUR');
  const post = calls.find((call) => call.method === 'POST');
  assert.deepEqual(post?.body, { name: BACKUP_BUCKET_NAME, storageClass: 'Standard' });
  assert.equal(post?.headers.get('content-type'), 'application/json');
});

test('losing a race to create the bucket finds the one that won', async () => {
  let lists = 0;
  const { api } = fakeApi(({ method }) => {
    if (method === 'POST') return Response.json({ success: false, errors: [{ code: 10004, message: 'The bucket you tried to create already exists' }], result: null }, { status: 409 });
    lists += 1;
    return ok({ buckets: lists === 1 ? [] : [{ name: BACKUP_BUCKET_NAME }] });
  });
  assert.deepEqual(await api.ensureBackupBucket(ACCOUNT), { bucket: { name: BACKUP_BUCKET_NAME, createdAt: null, location: null, jurisdiction: 'default' }, created: false });
});

test('an envelope error keeps its codes and names the failure', async () => {
  const { api } = fakeApi(() => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null }, { status: 403 }));
  await assert.rejects(api.listBuckets(ACCOUNT), (error: unknown) => error instanceof CloudflareApiError && error.code === 'cloudflare_forbidden' && error.status === 403 && error.apiCodes[0] === 10000 && /Authentication error/u.test(error.message));
  const { api: unsuccessful } = fakeApi(() => Response.json({ success: false, errors: [], result: null }));
  await assert.rejects(unsuccessful.listAccounts(), (error: unknown) => error instanceof CloudflareApiError && error.code === 'cloudflare_request_failed');
});

test('a 429 stops with the wait Cloudflare asked for, five minutes when it did not say', async () => {
  const { api } = fakeApi(() => new Response('', { status: 429, headers: { 'retry-after': '17' } }));
  await assert.rejects(api.listAccounts(), (error: unknown) => error instanceof CloudflareRateLimitError && error.retryAfterSeconds === 17);
  const { api: silent } = fakeApi(() => new Response('', { status: 429 }));
  await assert.rejects(silent.listAccounts(), (error: unknown) => error instanceof CloudflareRateLimitError && error.retryAfterSeconds === 300);
});

test('the rate limit header is remembered, tightest limit first', async () => {
  assert.deepEqual(parseRateLimit('"default";r=50;t=30, "burst";r=4;t=2'), { remaining: 4, resetSeconds: 2 });
  assert.equal(parseRateLimit(null), null);
  assert.equal(parseRateLimit('nonsense'), null);
  const { api } = fakeApi(() => ok([], { total_pages: 1 }, { ratelimit: '"default";r=1180;t=240' }));
  await api.listAccounts();
  assert.deepEqual(api.rateLimit, { remaining: 1180, resetSeconds: 240, observedAt: 42 });
});

test('account IDs are checked before they reach a URL', async () => {
  const { api, calls } = fakeApi(() => ok({ buckets: [] }));
  await assert.rejects(api.listBuckets('../../user/tokens'), (error: unknown) => error instanceof CloudflareApiError && error.code === 'cloudflare_invalid_account');
  assert.equal(calls.length, 0);
  assert.equal(s3Endpoint(ACCOUNT), `https://${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.equal(s3Endpoint(ACCOUNT, 'eu'), `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
});
