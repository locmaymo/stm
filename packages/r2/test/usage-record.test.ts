import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { R2Manager, type SyncSource } from '../src/index.js';
import { hashFile } from '../src/sync.js';
import { addOperations, monthKey, parseUsage, USAGE_MONTHS_KEPT } from '../src/usage-record.js';

const CREDENTIALS = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'stm-test-bucket',
  accessKeyId: 'access-key-1234',
  secretAccessKey: 'secret-key-5678',
  enabled: true,
} as const;

function profile(id: string): Profile {
  return {
    id, name: 'Default', installationId: 'install-1', runtimePath: '/runtime', configPath: '/runtime/config.yaml',
    dataPath: '/runtime/data', layout: 'data', active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null,
  };
}

/** One bucket, shared by however many managers the test makes. */
function sharedBucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort()
        .map((name) => `<Contents><Key>${name}</Key><Size>${objects.get(name)?.byteLength ?? 0}</Size><LastModified>2026-09-11T00:00:00.000Z</LastModified><ETag>"etag"</ETag></Contents>`).join('');
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'PUT') {
      objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer()));
      return new Response('', { status: 200 });
    }
    if (method === 'GET') {
      const body = objects.get(key);
      if (!body) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response('', { status: 200 });
  };
  return { fetchImpl, objects };
}

async function machine(fetchImpl: typeof fetch, now: () => Date): Promise<{ manager: R2Manager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-usage-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const manager = new R2Manager({ paths, env: { STM_DATA_DIR: root }, logger: () => undefined, fetchImpl, now });
  await manager.update({ ...CREDENTIALS });
  return { manager, root };
}

async function source(root: string, name: string, body: string): Promise<SyncSource> {
  const path = join(root, name.replaceAll('/', '-'));
  await writeFile(path, body);
  const file = await hashFile(name, path);
  assert.ok(file);
  return { file, path };
}

test('a month is added to, not replaced, and old months fall off the end', () => {
  const now = new Date('2026-09-19T09:00:00.000Z');
  const first = addOperations(null, '2026-09', { classA: 10, classB: 4 }, now);
  assert.equal(first.startedAt, now.toISOString());
  const second = addOperations(first, '2026-09', { classA: 5, classB: 0 }, now);
  assert.deepEqual(second.months['2026-09'], { classA: 15, classB: 4 });
  // The record belongs to the bucket, so the first machine's spending is still
  // there when a second one writes its own.
  assert.equal(second.startedAt, first.startedAt);

  let record = second;
  for (let month = 1; month <= 24; month += 1) record = addOperations(record, `2028-${String(month % 12 + 1).padStart(2, '0')}`, { classA: 1, classB: 1 }, now);
  assert.ok(Object.keys(record.months).length <= USAGE_MONTHS_KEPT);
});

test('a record nobody can read is treated as absent rather than trusted', () => {
  assert.equal(parseUsage('not an object'), null);
  assert.equal(parseUsage({ months: {} }), null);
  // Months that are not months, and counts that are not counts, are dropped
  // rather than making the whole record unreadable.
  const salvaged = parseUsage({ updatedAt: '2026-09-19T09:00:00.000Z', months: { 'last-month': { classA: 3 }, '2026-09': { classA: -2, classB: 'lots' } } });
  assert.deepEqual(salvaged?.months, { '2026-09': { classA: 0, classB: 0 } });
});

test('the count of charged operations survives the machine that made it', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const bucket = sharedBucket();
  const first = await machine(bucket.fetchImpl, () => new Date(clock.now));

  // A backup, then a look at the bucket, which is what settles up.
  await first.manager.syncProfile({ profile: profile('profile-1'), sources: [await source(first.root, 'chats/one.jsonl', 'hello')], fingerprint: 'f1' });
  const checked = await first.manager.inspect();
  assert.equal(checked.ok, true, checked.failure?.message ?? '');
  const spent = checked.usage?.writeOperations ?? 0;
  assert.ok(spent > 0, 'a backup and a listing are charged');
  assert.equal(checked.usage?.sharedRecord, true);
  assert.ok(bucket.objects.has('sillytavern-manager/usage.json'));

  // The machine is gone: a new computer, a reinstall, or a studio that starts
  // each time from nothing. It has never made a request in its life, and the
  // month it is landing in the middle of is already partly spent.
  const second = await machine(bucket.fetchImpl, () => new Date(clock.now));
  const fresh = await second.manager.getConfig();
  assert.equal(fresh.usage.writeOperations, 0);

  const inherited = await second.manager.inspect();
  assert.equal(inherited.ok, true, inherited.failure?.message ?? '');
  assert.ok((inherited.usage?.writeOperations ?? 0) >= spent, 'the month carries over rather than starting again');
  assert.equal(inherited.usage?.sharedRecord, true);
  assert.equal(inherited.usage?.countingSince, checked.usage?.countingSince);
});

test('what a machine spent is added once, however often it settles up', async () => {
  const clock = { now: Date.parse('2026-09-19T09:00:00.000Z') };
  const bucket = sharedBucket();
  const only = await machine(bucket.fetchImpl, () => new Date(clock.now));

  await only.manager.syncProfile({ profile: profile('profile-1'), sources: [await source(only.root, 'chats/one.jsonl', 'hello')], fingerprint: 'f1' });
  const first = await only.manager.inspect();
  const after = await only.manager.inspect();

  // The second Check costs a listing and a read of the record, so the figure
  // moves - but by what that Check cost, not by the whole month again.
  const spent = first.usage?.writeOperations ?? 0;
  assert.ok((after.usage?.writeOperations ?? 0) > spent);
  assert.ok((after.usage?.writeOperations ?? 0) < spent * 2, 'the earlier total is not counted twice');
});

test('a new month starts both counts again', async () => {
  const clock = { now: Date.parse('2026-09-30T23:00:00.000Z') };
  const bucket = sharedBucket();
  const only = await machine(bucket.fetchImpl, () => new Date(clock.now));
  await only.manager.syncProfile({ profile: profile('profile-1'), sources: [await source(only.root, 'chats/one.jsonl', 'hello')], fingerprint: 'f1' });
  const september = await only.manager.inspect();
  assert.ok((september.usage?.readOperations ?? 0) >= 0);
  assert.ok((september.usage?.writeOperations ?? 0) > 0);

  clock.now = Date.parse('2026-10-01T01:00:00.000Z');
  const october = await only.manager.getConfig();
  // Cloudflare's allowance is monthly and so are both counts. The read count
  // used to run on forever, measured against a monthly ceiling.
  assert.equal(october.usage.writeOperations, 0);
  assert.equal(october.usage.readOperations, 0);
  assert.notEqual(monthKey(new Date(clock.now)), '2026-09');
});
