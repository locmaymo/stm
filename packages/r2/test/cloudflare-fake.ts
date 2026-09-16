import { CLOUDFLARE_OAUTH, WORKER_SCRIPT_NAME } from '../../cloudflare/src/index.js';
import { loadWorker, MemoryBucket, workerFetch } from '../../cloudflare/test/worker-harness.js';

export const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
export const OTHER_ACCOUNT_ID = 'fedcba9876543210fedcba9876543210';

export interface FakeCloudflareState {
  accounts: Array<{ id: string; name: string }>;
  grantedScopes: string[];
  /** The refresh token Cloudflare currently accepts; rotated on every refresh. */
  refreshToken: string | null;
  accessTokenSerial: number;
  expiresIn: number;
  buckets: Map<string, MemoryBucket>;
  secrets: Map<string, string>;
  deployed: boolean;
  workersDevBlocked: boolean;
  revoked: string[];
  calls: string[];
}

/**
 * One Cloudflare account as far as the manager uses it: OAuth, accounts,
 * buckets, the Worker API, the Worker itself on workers.dev (running the real
 * source) and the REST object endpoints.
 */
export async function fakeCloudflare(overrides: Partial<FakeCloudflareState> = {}): Promise<{ state: FakeCloudflareState; fetchImpl: typeof fetch }> {
  const state: FakeCloudflareState = {
    accounts: [{ id: ACCOUNT_ID, name: 'Personal' }],
    grantedScopes: ['workers-r2.read', 'workers-r2.write', 'workers-r2-bucket-item.read', 'workers-r2-bucket-item.write', 'workers-scripts.write', 'account-analytics.read', 'offline_access'],
    refreshToken: null,
    accessTokenSerial: 0,
    expiresIn: 3600,
    buckets: new Map(),
    secrets: new Map(),
    deployed: false,
    workersDevBlocked: false,
    revoked: [],
    calls: [],
    ...overrides,
  };
  const worker = await loadWorker();
  const ok = (result: unknown, resultInfo?: unknown) => Response.json({ success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) });
  const fail = (status: number, message: string) => Response.json({ success: false, errors: [{ code: 10000, message }], result: null }, { status });
  const issue = () => {
    state.accessTokenSerial += 1;
    state.refreshToken = `refresh-${state.accessTokenSerial}`;
    return Response.json({ access_token: `access-${state.accessTokenSerial}`, refresh_token: state.refreshToken, expires_in: state.expiresIn, token_type: 'bearer', scope: state.grantedScopes.join(' ') });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname.endsWith('.workers.dev')) {
      state.calls.push(`worker ${method} ${url.pathname}`);
      if (state.workersDevBlocked) throw new TypeError('fetch failed');
      const bucket = state.buckets.get('sillytavern-manager-backup');
      if (!state.deployed || !bucket) return new Response('', { status: 404 });
      return await workerFetch(worker, { BUCKET: bucket, ...Object.fromEntries(state.secrets) })(input, init);
    }
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    if (url.toString() === CLOUDFLARE_OAUTH.token) {
      state.calls.push(`oauth ${body.get('grant_type')}`);
      if (body.get('grant_type') === 'authorization_code') return body.get('code') === 'good-code' ? issue() : Response.json({ error: 'invalid_grant' }, { status: 400 });
      return body.get('refresh_token') === state.refreshToken ? issue() : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (url.toString() === CLOUDFLARE_OAUTH.revoke) {
      state.calls.push('oauth revoke');
      state.revoked.push(body.get('token') ?? '');
      if (body.get('token') === state.refreshToken) state.refreshToken = null;
      return new Response(null, { status: 200 });
    }

    const authorization = new Headers(init?.headers as HeadersInit).get('authorization');
    if (authorization !== `Bearer access-${state.accessTokenSerial}`) return fail(401, 'Invalid access token');
    const path = url.pathname.replace('/client/v4', '');
    state.calls.push(`api ${method} ${path.replace(`/accounts/${ACCOUNT_ID}`, '').replace(`/accounts/${OTHER_ACCOUNT_ID}`, '')}`);
    if (path === '/accounts') return ok(state.accounts, { total_pages: 1 });
    const accountMatch = /^\/accounts\/([0-9a-f]{32})(\/.*)$/u.exec(path);
    if (!accountMatch) return fail(404, 'no route');
    const rest = accountMatch[2] ?? '';
    if (rest === '/r2/buckets' && method === 'GET') return ok({ buckets: [...state.buckets.keys()].map((name) => ({ name })) });
    if (rest === '/r2/buckets' && method === 'POST') {
      const name = (JSON.parse(String(init?.body)) as { name: string }).name;
      state.buckets.set(name, new MemoryBucket());
      return ok({ name });
    }
    const objects = /^\/r2\/buckets\/([^/]+)\/objects(?:\/(.*))?$/u.exec(rest);
    if (objects) {
      const bucket = state.buckets.get(objects[1] ?? '');
      if (!bucket) return fail(404, 'bucket');
      const key = objects[2] === undefined ? undefined : decodeURIComponent(objects[2]);
      if (key === undefined) {
        const listed = await bucket.list({ prefix: url.searchParams.get('prefix') ?? '', limit: Number(url.searchParams.get('per_page') ?? 1000), ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') as string } : {}) });
        return ok(listed.objects.map((entry) => ({ key: entry.key, size: entry.size })), { is_truncated: listed.truncated, cursor: listed.cursor ?? '' });
      }
      if (method === 'PUT') { await bucket.put(key, new Response(init?.body as BodyInit).body); return ok({ key }); }
      if (method === 'GET') { const stored = await bucket.get(key); return stored ? new Response(stored.body) : fail(404, 'missing'); }
      if (method === 'DELETE') { await bucket.delete(key); return ok(null); }
    }
    if (!state.grantedScopes.includes('workers-scripts.write') && rest.startsWith('/workers')) return fail(403, 'Authentication error');
    if (rest === '/workers/subdomain') return ok({ subdomain: 'acme' });
    if (rest === `/workers/scripts/${WORKER_SCRIPT_NAME}` && method === 'PUT') {
      const form = init?.body as FormData;
      const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as { bindings: Array<{ type: string; name: string; text?: string }> };
      for (const binding of metadata.bindings) if (binding.type === 'secret_text' && binding.text) state.secrets.set(binding.name, binding.text);
      state.deployed = true;
      return ok({});
    }
    if (rest === `/workers/scripts/${WORKER_SCRIPT_NAME}/subdomain`) return ok({ enabled: true });
    if (rest === `/workers/scripts/${WORKER_SCRIPT_NAME}/secrets` && method === 'PUT') {
      if (!state.deployed) return fail(404, 'script not found');
      const secret = JSON.parse(String(init?.body)) as { name: string; text: string };
      state.secrets.set(secret.name, secret.text);
      return ok({});
    }
    if (rest.startsWith(`/workers/scripts/${WORKER_SCRIPT_NAME}/secrets/`) && method === 'DELETE') {
      return state.secrets.delete(rest.slice(`/workers/scripts/${WORKER_SCRIPT_NAME}/secrets/`.length)) ? ok(null) : fail(404, 'secret');
    }
    return fail(404, `unhandled ${method} ${rest}`);
  };
  return { state, fetchImpl };
}
