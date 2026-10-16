/**
 * The Google token broker: the one place the Google OAuth client secret lives.
 *
 * Google's web clients want the secret at the code exchange and at every
 * refresh. It cannot ship with the manager - the repository is public, and
 * anything in the npm package or the APK can be read back out of it - so the
 * manager sends the code (or the refresh token) here, this adds the secret and
 * passes the request on to Google's token endpoint, and hands Google's answer
 * back. The secret is a Worker secret set in the dashboard, never a file.
 *
 * What this deliberately is not:
 * - a proxy: it talks to one address, Google's token endpoint, and the
 *   redirect URI is fixed here rather than taken from the request;
 * - a store: nothing is kept and no body or token is logged;
 * - a browser endpoint: it answers no CORS preflight and wants a JSON body,
 *   so a page on another site cannot use it from a visitor's browser. The
 *   manager calls it from its own server.
 * - the data path: backups go from the manager straight to Google with the
 *   access token. Only tokens pass through here.
 *
 * Only `/api/*` reaches the Worker (`run_worker_first` in wrangler.jsonc);
 * every other address is served from the static site without running it.
 * `worker.ts` is the entry point; this file is kept apart from it because
 * the Workers runtime takes every named export of the entry as a handler.
 */

export interface Env {
  /** Public by design; it is also in the manager's code. */
  readonly GOOGLE_CLIENT_ID?: string;
  /** The secret. Set with `wrangler secret put` or in the dashboard. */
  readonly GOOGLE_CLIENT_SECRET?: string;
  /**
   * The redirect registered on the client, which the code exchange has to
   * repeat exactly. Configured rather than read off the request: a local
   * `wrangler dev` reports the route's host, not the address it was called at.
   */
  readonly GOOGLE_REDIRECT_URI?: string;
  /** "1" stops new sign-ins while refreshes keep working - for abuse. */
  readonly GOOGLE_SIGNIN_PAUSED?: string;
  /** Optional rate limiter binding, keyed by the caller's address. */
  readonly GOOGLE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';
const MAX_BODY_BYTES = 4096;

/** The fields of Google's answer the manager needs; anything else is dropped. */
const PASSED_FIELDS = ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type', 'error', 'error_description'] as const;

// RFC 7636: 43 to 128 characters from the unreserved set.
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
// Codes and refresh tokens are opaque; bounded and free of whitespace and
// anything that would need escaping is all that can be checked.
const OPAQUE = /^[A-Za-z0-9\-._~/+=]{10,2048}$/;

export async function handle(request: Request, env: Env, fetchImpl: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname === '/api/google/token' ? 'token' : url.pathname === '/api/google/refresh' ? 'refresh' : null;
  if (!route) return reply(404, { error: 'not_found' });
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return reply(415, { error: 'unsupported_media_type' });
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return reply(503, { error: 'broker_not_configured' });
  if (route === 'token' && env.GOOGLE_SIGNIN_PAUSED === '1') return reply(503, { error: 'signin_paused' });

  if (env.GOOGLE_LIMITER) {
    const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.GOOGLE_LIMITER.limit({ key });
    if (!success) return reply(429, { error: 'rate_limited' }, { 'retry-after': '60' });
  }

  const body = await readBody(request);
  if (!body) return reply(400, { error: 'invalid_request' });

  const form = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
  if (route === 'token') {
    const { code, code_verifier: verifier } = body;
    if (typeof code !== 'string' || !OPAQUE.test(code) || typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
      return reply(400, { error: 'invalid_request' });
    }
    form.set('grant_type', 'authorization_code');
    form.set('code', code);
    form.set('code_verifier', verifier);
    form.set('redirect_uri', env.GOOGLE_REDIRECT_URI || new URL(GOOGLE_CALLBACK_PATH, url.origin).toString());
  } else {
    const { refresh_token: refreshToken } = body;
    if (typeof refreshToken !== 'string' || !OPAQUE.test(refreshToken)) return reply(400, { error: 'invalid_request' });
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refreshToken);
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
  } catch {
    return reply(502, { error: 'upstream_unreachable' });
  }
  let parsed: unknown;
  try {
    parsed = await upstream.json();
  } catch {
    return reply(502, { error: 'upstream_invalid_response' });
  }
  const passed: Record<string, unknown> = {};
  if (typeof parsed === 'object' && parsed !== null) {
    for (const field of PASSED_FIELDS) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string' || typeof value === 'number') passed[field] = value;
    }
  }
  return reply(upstream.status, passed);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
