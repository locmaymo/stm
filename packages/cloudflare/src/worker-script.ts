/**
 * The Worker the manager deploys into the user's account to carry backup data.
 *
 * It exists because an OAuth grant cannot be given S3 credentials, and the REST
 * API's rate limit is too small for a first backup. Requests to a Worker do not
 * touch that limit, and the Worker reaches the bucket through a binding.
 *
 * What it will do is deliberately small: list, put, get and delete objects under
 * the manager's prefix, and nothing outside it.
 *
 * Authentication, per request:
 * - `x-stm-key-id` names which installation is calling. Each one has its own
 *   Worker secret, `STM_KEY_<id>`, so a second machine rotating its key never
 *   locks out the first.
 * - The secret holds `<expiry epoch ms>.<key>`. An expired key is refused, so a
 *   machine that is gone, or a grant that was revoked and can no longer rotate,
 *   stops working on its own.
 * - `x-stm-signature` is HMAC-SHA256 of `METHOD\npath+query\ntimestamp` with the
 *   key, and the timestamp must be within five minutes. The key itself is never
 *   sent.
 *
 * Bump `WORKER_VERSION` whenever the source changes; a manager that finds an
 * older version deployed replaces it. The version answer also names the bucket
 * the deployment is bound to, so a manager whose bucket changed redeploys
 * instead of writing into the old one.
 */
export const WORKER_VERSION = 2;
export const WORKER_SCRIPT_NAME = 'sillytavern-manager-backup';
export const WORKER_OBJECT_PREFIX = 'sillytavern-manager/';
export const WORKER_COMPATIBILITY_DATE = '2026-09-01';
/** How far a request's timestamp may be from the Worker's clock. */
export const WORKER_MAX_SKEW_MS = 5 * 60 * 1000;

export const WORKER_SOURCE = `const VERSION = ${WORKER_VERSION};
const PREFIX = ${JSON.stringify(WORKER_OBJECT_PREFIX)};
const MAX_SKEW_MS = ${WORKER_MAX_SKEW_MS};
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!(await authorized(request, url, env))) return json({ error: 'unauthorized' }, 401);
      if (url.pathname === '/v1/version' && request.method === 'GET') return json({ version: VERSION, bucket: typeof env.BUCKET_NAME === 'string' ? env.BUCKET_NAME : null });
      if (url.pathname === '/v1/list' && request.method === 'GET') return await list(url, env);
      if (url.pathname.startsWith('/v1/o/')) return await object(request, url, env);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: 'internal', message: String(error && error.message || error).slice(0, 200) }, 500);
    }
  },
};

async function authorized(request, url, env) {
  const id = request.headers.get('x-stm-key-id') || '';
  const timestamp = request.headers.get('x-stm-timestamp') || '';
  const signature = request.headers.get('x-stm-signature') || '';
  if (!/^[a-z0-9]{8,64}$/.test(id) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const stored = env['STM_KEY_' + id];
  if (typeof stored !== 'string') return false;
  const dot = stored.indexOf('.');
  const expires = Number(stored.slice(0, dot));
  const key = stored.slice(dot + 1);
  if (dot < 1 || !key || !(expires > Date.now())) return false;
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(Date.now() - sent) > MAX_SKEW_MS) return false;
  const material = request.method + '\\n' + url.pathname + url.search + '\\n' + timestamp;
  const hmac = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  // verify compares in constant time, which a string comparison would not.
  return await crypto.subtle.verify('HMAC', hmac, hexBytes(signature), encoder.encode(material));
}

async function list(url, env) {
  const prefix = url.searchParams.get('prefix') || PREFIX;
  if (!prefix.startsWith(PREFIX)) return json({ error: 'forbidden_key' }, 403);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 1000, 1), 1000);
  const cursor = url.searchParams.get('cursor') || undefined;
  const listed = await env.BUCKET.list({ prefix, limit, cursor });
  return json({
    objects: listed.objects.map((entry) => ({ key: entry.key, size: entry.size, etag: entry.etag, uploaded: entry.uploaded ? new Date(entry.uploaded).toISOString() : null })),
    cursor: listed.truncated ? listed.cursor : null,
  });
}

async function object(request, url, env) {
  const key = decodeURIComponent(url.pathname.slice('/v1/o/'.length));
  if (!allowedKey(key)) return json({ error: 'forbidden_key' }, 403);
  if (request.method === 'PUT') {
    const stored = await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' } });
    return json({ size: stored.size, etag: stored.etag });
  }
  if (request.method === 'GET') {
    const stored = await env.BUCKET.get(key);
    if (!stored) return json({ error: 'not_found' }, 404);
    return new Response(stored.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(stored.size) } });
  }
  if (request.method === 'DELETE') {
    await env.BUCKET.delete(key);
    return new Response(null, { status: 204 });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

function allowedKey(key) {
  return key.length <= 1024 && key.startsWith(PREFIX) && !key.split('/').some((part) => part === '..' || part === '.');
}

function hexBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
`;
