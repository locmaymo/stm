import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareApi, CloudflareApiError } from '../src/api.js';
import { WORKER_SCRIPT_NAME, WORKER_SOURCE, WORKER_VERSION } from '../src/worker-script.js';
import { BackupWorker, WORKER_KEY_TTL_MS, WORKER_ROTATE_AFTER_MS } from '../src/workers.js';
import { loadWorker, MemoryBucket, workerFetch } from './worker-harness.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SCRIPTS = `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER_SCRIPT_NAME}`;

interface Account {
  subdomain: string | null;
  deployed: { version: number; metadata: Record<string, unknown>; source: string } | null;
  secrets: Map<string, string>;
  calls: string[];
}

/**
 * Cloudflare's Worker endpoints over an in-memory account, with the deployed
 * Worker answering on workers.dev from the secrets that were put.
 */
async function fakeCloudflare(initial: Partial<Account> = {}): Promise<{ account: Account; api: CloudflareApi; fetchImpl: typeof fetch; bucket: MemoryBucket }> {
  const account: Account = { subdomain: 'acme', deployed: null, secrets: new Map(), calls: [], ...initial };
  const bucket = new MemoryBucket();
  const realWorker = await loadWorker();
  const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
  const fail = (status: number, code: number) => Response.json({ success: false, errors: [{ code, message: 'nope' }], result: null }, { status });
  const apiFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    const method = init?.method ?? 'GET';
    account.calls.push(`${method} ${url.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '')}`);
    if (url.pathname.endsWith('/workers/subdomain')) {
      if (method === 'GET') return account.subdomain ? ok({ subdomain: account.subdomain }) : fail(404, 10007);
      account.subdomain = (JSON.parse(String(init?.body)) as { subdomain: string }).subdomain;
      return ok({ subdomain: account.subdomain });
    }
    if (url.pathname === SCRIPTS && method === 'PUT') {
      const form = init?.body as FormData;
      const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as Record<string, unknown>;
      const source = await (form.get('worker.js') as Blob).text();
      account.deployed = { version: WORKER_VERSION, metadata, source };
      if (!(metadata.keep_bindings as string[] | undefined)?.includes('secret_text')) account.secrets.clear();
      for (const binding of metadata.bindings as Array<{ type: string; name: string; text?: string }>) {
        if (binding.type === 'secret_text' && binding.text) account.secrets.set(binding.name, binding.text);
      }
      return ok({ id: WORKER_SCRIPT_NAME });
    }
    if (url.pathname === `${SCRIPTS}/subdomain`) return ok({ enabled: true });
    if (url.pathname === `${SCRIPTS}/secrets` && method === 'PUT') {
      if (!account.deployed) return fail(404, 10007);
      const secret = JSON.parse(String(init?.body)) as { name: string; text: string; type: string };
      assert.equal(secret.type, 'secret_text');
      account.secrets.set(secret.name, secret.text);
      return ok({ name: secret.name, type: 'secret_text' });
    }
    if (url.pathname.startsWith(`${SCRIPTS}/secrets/`) && method === 'DELETE') {
      const name = url.pathname.slice(`${SCRIPTS}/secrets/`.length);
      if (!account.secrets.delete(name)) return fail(404, 10056);
      return ok(null);
    }
    return fail(400, 1);
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    if (url.hostname.endsWith('.workers.dev')) {
      assert.equal(url.hostname, `${WORKER_SCRIPT_NAME}.${account.subdomain}.workers.dev`);
      if (!account.deployed) return new Response('', { status: 404 });
      // An older deployment is simulated by reporting the version it was given.
      const bound = (account.deployed.metadata.bindings as Array<{ type: string; name: string; text?: string }>).find((binding) => binding.name === 'BUCKET_NAME')?.text;
      const env = { BUCKET: bucket, ...(bound ? { BUCKET_NAME: bound } : {}), ...Object.fromEntries(account.secrets) };
      const response = await workerFetch(realWorker, env)(input, init);
      if (url.pathname === '/v1/version' && response.ok) return Response.json({ ...(await response.json() as object), version: account.deployed.version });
      return response;
    }
    return await apiFetch(input, init);
  };
  return { account, api: new CloudflareApi({ accessToken: async () => 'access', fetchImpl }), fetchImpl, bucket };
}

const noSleep = async (): Promise<void> => undefined;

test('the first session deploys the Worker, keeps secrets across deploys, and keys this installation', async () => {
  const { account, api, fetchImpl } = await fakeCloudflare();
  const session = await new BackupWorker({ api, fetchImpl, sleep: noSleep, now: () => Date.now() }).open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  assert.equal(session.baseUrl, `https://${WORKER_SCRIPT_NAME}.acme.workers.dev`);
  assert.equal(account.deployed?.source, WORKER_SOURCE);
  // The key goes up in the same deployment as the code, never as a second version after it.
  assert.deepEqual(account.deployed?.metadata.bindings, [
    { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'sillytavern-manager-backup' },
    { type: 'plain_text', name: 'BUCKET_NAME', text: 'sillytavern-manager-backup' },
    { type: 'secret_text', name: 'STM_KEY_install0001', text: `${session.expiresAt}.${session.key}` },
  ]);
  assert.deepEqual(account.deployed?.metadata.keep_bindings, ['secret_text']);
  assert.equal(account.secrets.get('STM_KEY_install0001'), `${session.expiresAt}.${session.key}`);
  assert.equal(session.expiresAt - session.issuedAt, WORKER_KEY_TTL_MS);
  assert.equal(session.rotateAt - session.issuedAt, WORKER_ROTATE_AFTER_MS);
  assert.deepEqual(account.calls, [
    'GET /workers/subdomain',
    `PUT /workers/scripts/${WORKER_SCRIPT_NAME}/secrets`,
    `PUT /workers/scripts/${WORKER_SCRIPT_NAME}`,
    `POST /workers/scripts/${WORKER_SCRIPT_NAME}/subdomain`,
  ]);
});

test('a deployed, current Worker only gets a new key, and another installation keeps its own', async () => {
  const { account, api, fetchImpl } = await fakeCloudflare();
  const worker = new BackupWorker({ api, fetchImpl, sleep: noSleep });
  const first = await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  account.calls.length = 0;
  const second = await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0002');
  assert.deepEqual(account.calls, ['GET /workers/subdomain', `PUT /workers/scripts/${WORKER_SCRIPT_NAME}/secrets`]);
  assert.notEqual(first.key, second.key);
  assert.equal(account.secrets.size, 2);
  // Rotating one installation replaces only its own secret.
  const rotated = await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  assert.equal(account.secrets.get('STM_KEY_install0001'), `${rotated.expiresAt}.${rotated.key}`);
  assert.equal(account.secrets.get('STM_KEY_install0002'), `${second.expiresAt}.${second.key}`);
});

test('an older Worker is replaced', async () => {
  const { account, api, fetchImpl } = await fakeCloudflare();
  const worker = new BackupWorker({ api, fetchImpl, sleep: noSleep });
  await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  if (account.deployed) account.deployed.version = WORKER_VERSION - 1;
  account.calls.length = 0;
  await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  assert.ok(account.calls.includes(`PUT /workers/scripts/${WORKER_SCRIPT_NAME}`));
  assert.equal(account.deployed?.version, WORKER_VERSION);
});

test('a Worker bound to another bucket is redeployed onto this one', async () => {
  const { account, api, fetchImpl } = await fakeCloudflare();
  const worker = new BackupWorker({ api, fetchImpl, sleep: noSleep });
  await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  account.calls.length = 0;
  await worker.open(ACCOUNT, 'stm', 'install0001');
  assert.ok(account.calls.includes(`PUT /workers/scripts/${WORKER_SCRIPT_NAME}`));
  assert.deepEqual((account.deployed?.metadata.bindings as unknown[]).slice(0, 2), [
    { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'stm' },
    { type: 'plain_text', name: 'BUCKET_NAME', text: 'stm' },
  ]);
  // Bound where it should be, the next session only gets a key.
  account.calls.length = 0;
  await worker.open(ACCOUNT, 'stm', 'install0001');
  assert.deepEqual(account.calls, ['GET /workers/subdomain', `PUT /workers/scripts/${WORKER_SCRIPT_NAME}/secrets`]);
});

test('an account without a workers.dev subdomain gets one', async () => {
  const { account, api, fetchImpl } = await fakeCloudflare({ subdomain: null });
  const session = await new BackupWorker({ api, fetchImpl, sleep: noSleep }).open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  assert.equal(account.subdomain, 'stm-0123456789ab');
  assert.equal(session.baseUrl, `https://${WORKER_SCRIPT_NAME}.stm-0123456789ab.workers.dev`);
});

test('one answer is not enough: every request of several bursts in a row has to pass', async () => {
  const { api, fetchImpl } = await fakeCloudflare();
  let versionChecks = 0;
  // One edge in the first twenty requests has not caught up with the key yet.
  const flaky: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/v1/version')) {
      versionChecks += 1;
      if (versionChecks === 20) return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return await fetchImpl(input, init);
  };
  await new BackupWorker({ api, fetchImpl: flaky, sleep: noSleep }).open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  // Bursts of 8: the third holds the refusal, so bursts four to six are the three in a row.
  assert.equal(versionChecks, 48);
});

test('a Worker that never answers is reported as unreachable', async () => {
  const { api, fetchImpl } = await fakeCloudflare();
  const blocked: typeof fetch = async (input, init) => {
    if (String(input).includes('.workers.dev')) throw new TypeError('fetch failed');
    return await fetchImpl(input, init);
  };
  await assert.rejects(new BackupWorker({ api, fetchImpl: blocked, sleep: noSleep }).open(ACCOUNT, 'sillytavern-manager-backup', 'install0001'), (error: unknown) => error instanceof CloudflareApiError && error.code === 'worker_unreachable');
});

test('removing a key deletes only this installation\'s secret, and a missing one is fine', async () => {
  const { account, api, fetchImpl } = await fakeCloudflare();
  const worker = new BackupWorker({ api, fetchImpl, sleep: noSleep });
  await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0001');
  await worker.open(ACCOUNT, 'sillytavern-manager-backup', 'install0002');
  await worker.removeKey(ACCOUNT, 'install0001');
  assert.deepEqual([...account.secrets.keys()], ['STM_KEY_install0002']);
  await worker.removeKey(ACCOUNT, 'install0001');
  await assert.rejects(worker.open(ACCOUNT, 'sillytavern-manager-backup', 'Not Valid'), (error: unknown) => error instanceof CloudflareApiError && error.code === 'worker_invalid_key_id');
});
