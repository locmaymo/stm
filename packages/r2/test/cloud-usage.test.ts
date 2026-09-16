import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCOPES } from '../../cloudflare/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { getPlatformPaths } from '../../platform/src/index.js';
import { CloudflareConnection, R2Error, R2Manager } from '../src/index.js';
import { hashFile } from '../src/sync.js';
import { fakeCloudflare, type FakeCloudflareState } from './cloudflare-fake.js';

const BUCKET = 'sillytavern-manager-backup';

async function connected(overrides: Partial<FakeCloudflareState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stm-cloud-usage-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const cloudflare = await fakeCloudflare(overrides);
  // The Worker in these tests checks timestamps against the real clock.
  const clock = { now: Date.now() };
  const connection = new CloudflareConnection({ paths, client: { clientId: 'c', redirectUri: 'http://localhost:7860/oauth/cloudflare/callback', scopes: Object.values(DEFAULT_SCOPES) }, fetchImpl: cloudflare.fetchImpl, now: () => clock.now, sleep: async () => undefined });
  const url = new URL(connection.beginConnect('http://localhost:7860'));
  await connection.completeConnect({ state: url.searchParams.get('state') ?? '', code: 'good-code' });
  const manager = new R2Manager({ paths, env: {}, cloudflare: connection, logger: () => undefined, now: () => new Date(clock.now) });
  await manager.update({ mode: 'cloudflare', enabled: true });
  const graphqlCalls = () => cloudflare.state.calls.filter((call) => call === 'api POST /graphql').length;
  return { root, manager, cloudflare, clock, graphqlCalls };
}

function profile(): Profile {
  return { id: 'profile-1', name: 'Default', installationId: 'i', runtimePath: '/r', configPath: '/r/config.yaml', dataPath: '/r/data', layout: 'data', active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null };
}

test('usage comes from Cloudflare, is reused for fifteen minutes, and warns near the free tier', async () => {
  const { manager, cloudflare, clock, graphqlCalls } = await connected();
  cloudflare.state.analytics.operations = [
    { sum: { requests: 900_000 }, dimensions: { actionType: 'PutObject', bucketName: 'devproxyvn', responseStatusCode: 200 } },
    { sum: { requests: 1_200 }, dimensions: { actionType: 'PutObject', bucketName: BUCKET, responseStatusCode: 200 } },
  ];
  cloudflare.state.analytics.storage = [{ max: { objectCount: 40, payloadSize: 2_000_000, metadataSize: 0 }, dimensions: { datetime: '2026-09-16T11:30:00Z', bucketName: BUCKET } }];

  const first = await manager.cloudflareUsage();
  assert.equal(first.unavailable, null);
  assert.equal(first.usage?.bucket.operations.classA, 1_200);
  assert.equal(first.usage?.account.operations.classA, 901_200);
  assert.equal(first.usage?.bucket.storageBytes, 2_000_000);
  assert.deepEqual(first.usage?.freeTier, { storageBytes: 10_000_000_000, classA: 1_000_000, classB: 10_000_000 });
  assert.deepEqual(first.usage?.warnings, [{ scope: 'account', metric: 'classA', used: 901_200, limit: 1_000_000 }]);

  clock.now += 10 * 60 * 1000;
  await manager.cloudflareUsage();
  assert.equal(graphqlCalls(), 1);
  await manager.cloudflareUsage({ refresh: true });
  assert.equal(graphqlCalls(), 2);
  clock.now += 16 * 60 * 1000;
  await manager.cloudflareUsage();
  assert.equal(graphqlCalls(), 3);
});

test('without the analytics scope, or with keys, there are no Cloudflare figures and it says why', async () => {
  const withoutAnalytics = await connected({ grantedScopes: ['workers-r2.read', 'workers-r2.write', 'workers-r2-bucket-item.read', 'workers-r2-bucket-item.write', 'workers-scripts.write', 'offline_access'] });
  assert.deepEqual(await withoutAnalytics.manager.cloudflareUsage(), { usage: null, unavailable: 'analytics_not_granted', error: null });
  const keys = await connected();
  await keys.manager.update({ mode: 'keys' });
  assert.deepEqual(await keys.manager.cloudflareUsage(), { usage: null, unavailable: 'keys_mode', error: null });
});

test('a failing query keeps the last figures and reports the error', async () => {
  const { manager, cloudflare } = await connected();
  const first = await manager.cloudflareUsage();
  cloudflare.state.analytics.failing = true;
  const failed = await manager.cloudflareUsage({ refresh: true });
  assert.deepEqual(failed.usage, first.usage);
  assert.match(failed.error ?? '', /not authorized/u);
  const fresh = await connected({ analytics: { operations: [], storage: [], failing: true } });
  const none = await fresh.manager.cloudflareUsage();
  assert.equal(none.usage, null);
  assert.equal(none.unavailable, 'query_failed');
});

test('what Cloudflare sees in the bucket counts against the ceiling, but analytics being down never stops a backup', async () => {
  const { manager, cloudflare, root } = await connected();
  await manager.update({ maxStorageBytes: 5 * 1024 * 1024 });
  cloudflare.state.analytics.storage = [{ max: { objectCount: 9_000, payloadSize: 6 * 1024 * 1024, metadataSize: 0 }, dimensions: { datetime: '2026-09-16T11:50:00Z', bucketName: BUCKET } }];
  const path = join(root, 'chat.jsonl');
  await writeFile(path, 'hello');
  const file = await hashFile('chats/chat.jsonl', path);
  assert.ok(file);
  const run = () => manager.syncProfile({ profile: profile(), sources: [{ file, path }], fingerprint: String(Math.random()) });
  // This manager has written nothing, but another machine filled the bucket.
  await assert.rejects(run(), (error: unknown) => error instanceof R2Error && error.code === 'r2_storage_ceiling');

  cloudflare.state.analytics.failing = true;
  const other = await connected({ analytics: { operations: [], storage: [], failing: true } });
  const otherPath = join(other.root, 'chat.jsonl');
  await writeFile(otherPath, 'hello');
  const otherFile = await hashFile('chats/chat.jsonl', otherPath);
  assert.ok(otherFile);
  const result = await other.manager.syncProfile({ profile: profile(), sources: [{ file: otherFile, path: otherPath }], fingerprint: 'x' });
  assert.equal(result.fileCount, 1);
});
