import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import { MetricsStore } from '../src/metrics.js';
import { startManagerServer, type ManagerServer } from '../src/server.js';
import type { Installation, Job } from '../../../packages/contracts/src/index.js';
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

async function waitFor(base: string, cookie: string, jobId: string): Promise<Job> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await (await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } })).json() as Job;
    if (job.state !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the upload never finished');
}

/**
 * Back up now, against a bucket that answers.
 *
 * The button is the one thing a reader presses when they want this machine to
 * be somewhere other than this machine, so what it sends is the whole of what
 * that promise is worth.
 */
test('Back up now sends the settings and the usage log, not only the chats', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-upload-now-'));
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
  const r2 = new R2Manager({ paths, env: {}, logger: () => undefined, fetchImpl: bucket.fetchImpl });
  await r2.update({
    endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'stm-test-bucket',
    accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678', enabled: true,
  });
  // Something in the usage log, because an empty one is nothing to send.
  const metrics = new MetricsStore(paths);
  await metrics.append({
    schemaVersion: 1, timestamp: at, provider: 'openai', model: 'gpt-4',
    endpointHost: 'api.openai.com', stream: false, maxTokens: null,
    inputTokens: 10, outputTokens: 5, totalTokens: 15, status: 200, durationMs: 120,
  });

  const manager = await startManagerServer({
    host: '127.0.0.1', port: 0, paths, secureCookies: false, accessPort: 0, runtime, r2, metrics,
    env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, cloudflare: null, logger: () => undefined,
  });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = /stm_session=[^;]+/u.exec(login.headers.get('set-cookie') ?? '')?.[0] ?? '';
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const headers = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  // The profile the manager makes for itself on the way up, with something in
  // it so there is a recovery point to send.
  const listed = await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ dataPath: string; active: boolean }> };
  const profile = listed.profiles.find((entry) => entry.active) ?? listed.profiles[0];
  assert.ok(profile, 'the manager has a profile to back up');
  await mkdir(join(profile.dataPath, 'default-user'), { recursive: true });
  await writeFile(join(profile.dataPath, 'default-user', 'settings.json'), '{"theme":"dark"}', 'utf8');

  const upload = await fetch(`${base}/api/v1/r2/sync`, { method: 'POST', headers });
  assert.equal(upload.status, 202);
  const job = await waitFor(base, cookie, (await upload.json() as { jobId: string }).jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');

  const keys = [...bucket.objects.keys()];
  // The chats, which is all this used to send.
  assert.ok(keys.some((key) => key.includes('/snapshots/')), 'the profile went up');
  /*
   * And the rest of what makes a machine a machine. Without these, somebody
   * who pressed the button, watched it finish and then lost the computer got
   * their chats back and a console with no password, no passcode, default
   * schedules and a usage page reading zero.
   */
  assert.ok(keys.includes('sillytavern-manager/manager.json'), 'the manager settings went up');
  assert.ok(keys.some((key) => key.endsWith('/metrics.json')), `the usage log went up; bucket holds ${keys.join(', ')}`);
});

function serverUrl(manager: ManagerServer): string {
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
