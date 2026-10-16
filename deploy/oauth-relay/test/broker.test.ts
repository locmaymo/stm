import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_TOKEN_ENDPOINT, handle, type Env } from '../src/broker.js';

const ORIGIN = 'https://relay.example';
const VERIFIER = 'v'.repeat(43);
const ENV: Env = { GOOGLE_CLIENT_ID: 'client-id.example', GOOGLE_CLIENT_SECRET: 'test-only-secret' };

interface Sent { url: string; body: URLSearchParams }

/** A stand-in for Google's token endpoint that records what it was sent. */
function fakeGoogle(status: number, answer: unknown): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, sent };
}

function post(path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('a code is exchanged with the secret added and the redirect fixed by the broker', async () => {
  const google = fakeGoogle(200, { access_token: 'a', expires_in: 3599, refresh_token: 'r', scope: 'drive.file', token_type: 'Bearer', id_token: 'dropped' });
  const response = await handle(post('/api/google/token', { code: '4/abcdefghijkl', code_verifier: VERIFIER, redirect_uri: 'https://evil.example/cb' }), ENV, google.fetch);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), { access_token: 'a', expires_in: 3599, refresh_token: 'r', scope: 'drive.file', token_type: 'Bearer' });

  assert.equal(google.sent.length, 1);
  const [sent] = google.sent;
  assert.equal(sent?.url, GOOGLE_TOKEN_ENDPOINT);
  assert.deepEqual(Object.fromEntries(sent?.body ?? []), {
    client_id: 'client-id.example',
    client_secret: 'test-only-secret',
    grant_type: 'authorization_code',
    code: '4/abcdefghijkl',
    code_verifier: VERIFIER,
    redirect_uri: `${ORIGIN}/oauth/google/callback`,
  });
});

test('a configured redirect wins over the address the broker was reached at', async () => {
  const google = fakeGoogle(200, { access_token: 'a', expires_in: 3599 });
  await handle(post('/api/google/token', { code: '4/abcdefghijkl', code_verifier: VERIFIER }), { ...ENV, GOOGLE_REDIRECT_URI: 'http://localhost:8799/oauth/google/callback' }, google.fetch);
  assert.equal(google.sent[0]?.body.get('redirect_uri'), 'http://localhost:8799/oauth/google/callback');
});

test('a refresh token is refreshed with the secret added', async () => {
  const google = fakeGoogle(200, { access_token: 'b', expires_in: 3599 });
  const response = await handle(post('/api/google/refresh', { refresh_token: '1/refresh-token-value' }), ENV, google.fetch);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(google.sent[0]?.body ?? []), {
    client_id: 'client-id.example',
    client_secret: 'test-only-secret',
    grant_type: 'refresh_token',
    refresh_token: '1/refresh-token-value',
  });
});

test('Google\'s refusal is passed back with its status', async () => {
  const google = fakeGoogle(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
  const response = await handle(post('/api/google/refresh', { refresh_token: '1/refresh-token-value' }), ENV, google.fetch);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
});

test('a code without a PKCE verifier is refused before Google is asked', async () => {
  const google = fakeGoogle(200, {});
  for (const body of [{ code: '4/abcdefghijkl' }, { code: '4/abcdefghijkl', code_verifier: 'short' }, { code: 'has space in it', code_verifier: VERIFIER }, ['not', 'an', 'object'], 'not json']) {
    const response = await handle(post('/api/google/token', body), ENV, google.fetch);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(google.sent.length, 0);
});

test('only JSON POSTs to the two routes are answered, and never a browser preflight', async () => {
  const google = fakeGoogle(200, {});
  assert.equal((await handle(new Request(`${ORIGIN}/api/google/token`), ENV, google.fetch)).status, 405);
  assert.equal((await handle(new Request(`${ORIGIN}/api/google/token`, { method: 'OPTIONS' }), ENV, google.fetch)).status, 405);
  assert.equal((await handle(post('/api/google/token', 'code=x', { 'content-type': 'application/x-www-form-urlencoded' }), ENV, google.fetch)).status, 415);
  assert.equal((await handle(post('/api/google/other', {}), ENV, google.fetch)).status, 404);
  assert.equal((await handle(post('/api/google/refresh', { refresh_token: 'x'.repeat(5000) }), ENV, google.fetch)).status, 400);
  assert.equal(google.sent.length, 0);
});

test('without its secret the broker says so instead of asking Google', async () => {
  const google = fakeGoogle(200, {});
  const response = await handle(post('/api/google/refresh', { refresh_token: '1/refresh-token-value' }), { GOOGLE_CLIENT_ID: 'client-id.example' }, google.fetch);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'broker_not_configured' });
  assert.equal(google.sent.length, 0);
});

test('pausing sign-ins stops new codes but keeps refreshes working', async () => {
  const google = fakeGoogle(200, { access_token: 'c', expires_in: 3599 });
  const paused: Env = { ...ENV, GOOGLE_SIGNIN_PAUSED: '1' };
  assert.equal((await handle(post('/api/google/token', { code: '4/abcdefghijkl', code_verifier: VERIFIER }), paused, google.fetch)).status, 503);
  assert.equal((await handle(post('/api/google/refresh', { refresh_token: '1/refresh-token-value' }), paused, google.fetch)).status, 200);
});

test('a caller over the rate limit is told to wait', async () => {
  const google = fakeGoogle(200, {});
  const keys: string[] = [];
  const limited: Env = { ...ENV, GOOGLE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
  const request = post('/api/google/refresh', { refresh_token: '1/refresh-token-value' }, { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.7' });
  const response = await handle(request, limited, google.fetch);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(keys, ['192.0.2.7']);
  assert.equal(google.sent.length, 0);
});

test('Google out of reach or answering nonsense is a 502, not a crash', async () => {
  const unreachable = (async () => { throw new TypeError('network down'); }) as typeof fetch;
  assert.equal((await handle(post('/api/google/refresh', { refresh_token: '1/refresh-token-value' }), ENV, unreachable)).status, 502);
  const garbage = (async () => new Response('<html>busy</html>', { status: 503 })) as typeof fetch;
  assert.equal((await handle(post('/api/google/refresh', { refresh_token: '1/refresh-token-value' }), ENV, garbage)).status, 502);
});
