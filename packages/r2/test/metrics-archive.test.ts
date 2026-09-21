import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { R2Manager, type SyncSource } from '../src/index.js';
import { hashFile } from '../src/sync.js';
import { parseMetricsArchive } from '../src/metrics-archive.js';

const CREDENTIALS = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'stm-test-bucket',
  accessKeyId: 'access-key-1234',
  secretAccessKey: 'secret-key-5678',
  enabled: true,
} as const;

function profile(): Profile {
  return {
    id: 'profile-1', name: 'Default', installationId: 'install-1', runtimePath: '/runtime', configPath: '/runtime/config.yaml',
    dataPath: '/runtime/data', layout: 'data', active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null,
  };
}

function bucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer>; puts: string[] } {
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort()
        .map((name) => `<Contents><Key>${name}</Key><Size>${objects.get(name)?.byteLength ?? 0}</Size><LastModified>2026-09-11T00:00:00.000Z</LastModified><ETag>"e"</ETag></Contents>`).join('');
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'PUT') {
      puts.push(key);
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
  return { fetchImpl, objects, puts };
}

async function machine(fetchImpl: typeof fetch): Promise<{ manager: R2Manager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-metrics-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const manager = new R2Manager({ paths, env: { STM_DATA_DIR: root }, logger: () => undefined, fetchImpl });
  await manager.update({ ...CREDENTIALS });
  return { manager, root };
}

/** One usage event as the instrumentation writes it, near enough for a log. */
function line(index: number): string {
  return `${JSON.stringify({ schemaVersion: 1, timestamp: '2026-09-19T09:00:00.000Z', provider: 'proxyvn.top', model: `m-${index}`, endpointHost: 'proxyvn.top', stream: true, maxTokens: 512, inputTokens: 10, outputTokens: 5, totalTokens: 15, status: 200, durationMs: 25 })}\n`;
}

test('an index that does not describe a file is not an index', () => {
  assert.equal(parseMetricsArchive({ chunks: [] }), null);
  const at = '2026-09-19T09:00:00.000Z';
  // Chunks are a file only if they are contiguous and in order; a gap or an
  // overlap would be written back as a log saying something else.
  assert.equal(parseMetricsArchive({ updatedAt: at, chunks: [{ hash: 'a'.repeat(64), offset: 4, length: 10 }] }), null);
  assert.equal(parseMetricsArchive({ updatedAt: at, chunks: [{ hash: 'zz', offset: 0, length: 10 }] }), null);
  // And the size has to be the size of them.
  assert.equal(parseMetricsArchive({ updatedAt: at, sizeBytes: 99, chunks: [{ hash: 'a'.repeat(64), offset: 0, length: 10 }] }), null);
  assert.ok(parseMetricsArchive({ updatedAt: at, chunks: [{ hash: 'a'.repeat(64), offset: 0, length: 10 }] }));
});

test('appending to the usage log sends the end of it, not the whole thing', async () => {
  const store = bucket();
  const { manager, root } = await machine(store.fetchImpl);
  const path = join(root, 'usage-events.jsonl');

  // Five megabytes of log: more than one chunk, so there is something for a
  // later run to skip.
  await mkdir(root, { recursive: true });
  await writeFile(path, '');
  for (let index = 0; index < 20_000; index += 1) await appendFile(path, line(index), 'utf8');
  const first = await manager.syncMetricsFile(path);
  assert.ok(first);
  assert.ok(first.uploadedChunks >= 2, `expected more than one chunk, got ${first.uploadedChunks}`);

  // Nothing has been appended: the stat answers it and nothing is sent.
  const quiet = store.puts.length;
  assert.equal(await manager.syncMetricsFile(path), null);
  assert.equal(store.puts.length, quiet);

  // One more line. Only the chunk at the end of the log has changed, so that
  // is all that goes up - with the index beside it.
  await appendFile(path, line(20_001), 'utf8');
  const second = await manager.syncMetricsFile(path);
  assert.equal(second?.uploadedChunks, 1, 'only the last chunk is rewritten by an append');
  const written = store.puts.slice(quiet);
  assert.equal(written.filter((key) => key.includes('/blobs/')).length, 1);
  assert.equal(written.filter((key) => key.endsWith('metrics.json')).length, 1);
  assert.equal(written.length, 2, 'one chunk and one index, however large the log has grown');
});

test('a machine with no history gets the log back, byte for byte', async () => {
  const store = bucket();
  const first = await machine(store.fetchImpl);
  const path = join(first.root, 'usage-events.jsonl');
  const body = Array.from({ length: 500 }, (_, index) => line(index)).join('');
  await writeFile(path, body, 'utf8');
  await first.manager.syncMetricsFile(path);

  const second = await machine(store.fetchImpl);
  const landed = join(second.root, 'metrics', 'usage-events.jsonl');
  const restored = await second.manager.restoreMetricsFile(landed);
  assert.equal(restored?.sizeBytes, Buffer.byteLength(body));
  assert.equal(await readFile(landed, 'utf8'), body);
});

test('a bucket with no usage log has nothing to give back', async () => {
  const store = bucket();
  const { manager, root } = await machine(store.fetchImpl);
  assert.equal(await manager.restoreMetricsFile(join(root, 'usage-events.jsonl')), null);
});

test('the sweep does not collect the log, which no recovery point names', async () => {
  const store = bucket();
  const { manager, root } = await machine(store.fetchImpl);

  // A profile in the bucket, so the sweep has recovery points to read, and a
  // usage log beside it, which they say nothing about.
  const chatPath = join(root, 'one.jsonl');
  await writeFile(chatPath, 'hello');
  const file = await hashFile('chats/one.jsonl', chatPath);
  assert.ok(file);
  const source: SyncSource = { file, path: chatPath };
  await manager.syncProfile({ profile: profile(), sources: [source], fingerprint: 'one' });

  const metricsPath = join(root, 'usage-events.jsonl');
  const body = Array.from({ length: 200 }, (_, index) => line(index)).join('');
  await writeFile(metricsPath, body, 'utf8');
  await manager.syncMetricsFile(metricsPath);

  const result = await manager.reconcile();
  assert.equal(result.collectedBlobs, 0, 'the log is referenced by its own index, not by a recovery point');

  // And it is still readable afterwards, which is the thing that matters.
  const landed = join(root, 'back.jsonl');
  assert.equal((await manager.restoreMetricsFile(landed))?.sizeBytes, Buffer.byteLength(body));
  assert.equal(await readFile(landed, 'utf8'), body);
});
