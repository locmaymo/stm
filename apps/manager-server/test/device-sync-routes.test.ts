import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import { startManagerServer, type ManagerServer } from '../src/server.js';
import type { DeviceSyncStatus, Installation } from '../../../packages/contracts/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';

/** An in-memory bucket answering the parts of S3 the manager speaks. */
function fakeBucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort()
        .map((name) => `<Contents><Key>${name}</Key><Size>${objects.get(name)?.byteLength ?? 0}</Size><LastModified>2026-09-20T00:00:00.000Z</LastModified><ETag>"e"</ETag></Contents>`).join('');
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'PUT') { objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer())); return new Response('', { status: 200 }); }
    if (method === 'GET') {
      const body = objects.get(key);
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('<Error/>', { status: 404 });
    }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response('', { status: 200 });
  };
  return { fetchImpl, objects };
}

const PASSWORD = 'correct horse battery staple';
const TOKEN = 'launcher-token-for-this-test';

test('the sharing routes are behind the console session, and the launcher route behind its token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-sync-routes-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const at = new Date().toISOString();
  const installation: Installation = {
    id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath,
    markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100,
    step: 'Installation ready', error: null, createdAt: at, updatedAt: at, activatedAt: at,
  };
  const runtime = {
    listVersions: async () => [], listInstallations: async () => [installation],
    getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
  } as unknown as RuntimeManager;
  const bucket = fakeBucket();
  const r2 = new R2Manager({ paths, env: {}, logger: () => undefined, fetchImpl: bucket.fetchImpl, installationLabel: 'desk', slot: { settleMs: 0, sleep: async () => undefined } });
  await r2.update({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'stm-test-bucket', accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678', enabled: true });

  const manager = await startManagerServer({
    host: '127.0.0.1', port: 0, paths, secureCookies: false, accessPort: 0, runtime, r2,
    env: { STM_ADMIN_PASSWORD: PASSWORD, STM_SHUTDOWN_TOKEN: TOKEN }, cloudflare: null, logger: () => undefined,
  });
  t.after(() => manager.close());
  const base = serverUrl(manager);

  // Nobody without a session learns anything or changes anything.
  assert.equal((await fetch(`${base}/api/v1/sync`)).status, 401);
  for (const action of ['start', 'join', 'resume', 'leave', 'outcome/dismiss']) {
    assert.equal((await fetch(`${base}/api/v1/sync/${action}`, { method: 'POST' })).status, 401, action);
  }

  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = /stm_session=[^;]+/u.exec(login.headers.get('set-cookie') ?? '')?.[0] ?? '';
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const headers = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  const read = async (): Promise<DeviceSyncStatus | null> => (await (await fetch(`${base}/api/v1/sync`, { headers: { cookie } })).json() as { sync: DeviceSyncStatus | null }).sync;

  assert.equal(await read(), null);
  // A session alone is not enough to change anything: the token against forged requests too.
  assert.equal((await fetch(`${base}/api/v1/sync/start`, { method: 'POST', headers: { cookie } })).status, 403);
  // Nothing to resume or join where nobody shares.
  assert.equal((await fetch(`${base}/api/v1/sync/resume`, { method: 'POST', headers })).status, 409);
  assert.equal((await fetch(`${base}/api/v1/sync/join`, { method: 'POST', headers })).status, 409);

  const listed = await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ dataPath: string; active: boolean }> };
  const profile = listed.profiles.find((entry) => entry.active) ?? listed.profiles[0];
  assert.ok(profile);
  await mkdir(join(profile.dataPath, 'default-user'), { recursive: true });
  await writeFile(join(profile.dataPath, 'default-user', 'settings.json'), '{"theme":"dark"}', 'utf8');

  const started = await fetch(`${base}/api/v1/sync/start`, { method: 'POST', headers });
  assert.equal(started.status, 202);
  assert.equal((await started.json() as { sync: DeviceSyncStatus }).sync.state, 'ready');
  assert.ok(bucket.objects.has('sillytavern-manager/sync/line.json'));
  // The page somebody is looking at is told too, not only the backup settings.
  const status = await (await fetch(`${base}/api/v1/status`, { headers: { cookie } })).json() as { sync?: DeviceSyncStatus | null };
  assert.equal(status.sync?.state, 'ready');

  // The app around the manager holds the launcher's token and no session.
  assert.equal((await fetch(`${base}/api/v1/sync/push`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/sync/push`, { method: 'POST', headers: { 'x-stm-shutdown-token': 'wrong' } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/sync/push`, { method: 'POST', headers: { 'x-stm-shutdown-token': TOKEN } })).status, 202);

  const left = await fetch(`${base}/api/v1/sync/leave`, { method: 'POST', headers });
  assert.equal(left.status, 200);
  assert.equal(await read(), null);
  // Storage still holds the line, for the other devices.
  assert.ok(bucket.objects.has('sillytavern-manager/sync/line.json'));
});

function serverUrl(manager: ManagerServer): string {
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
