import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  AUTHORIZATION_TTL_MS,
  CLOUDFLARE_OAUTH,
  CloudflareOAuthError,
  DEFAULT_SCOPES,
  createAuthorization,
  createPkcePair,
  decodeState,
  exchangeCode,
  matchesPending,
  refreshGrant,
  revokeToken,
  type OAuthClientSettings,
} from '../src/oauth.js';

const SETTINGS: OAuthClientSettings = {
  clientId: 'client-123',
  redirectUri: 'https://stm.example.com/oauth/cloudflare',
  scopes: Object.values(DEFAULT_SCOPES),
};

function recordingFetch(respond: (url: string, body: URLSearchParams) => Response): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: URLSearchParams; headers: Headers }> } {
  const calls: Array<{ url: string; body: URLSearchParams; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, body, headers: new Headers(init?.headers as HeadersInit) });
    return respond(url, body);
  };
  return { fetchImpl, calls };
}

test('the PKCE challenge is the S256 of the verifier', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(createPkcePair().verifier, verifier);
});

test('the authorize URL asks for a code with PKCE and a refresh token', () => {
  const pending = createAuthorization(SETTINGS, 'https://my-tunnel.trycloudflare.com/panel?x=1', 1_000);
  const url = new URL(pending.url);
  assert.equal(`${url.origin}${url.pathname}`, CLOUDFLARE_OAUTH.authorize);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), SETTINGS.redirectUri);
  assert.equal(url.searchParams.get('scope'), 'workers-r2.read workers-r2.write workers-r2-bucket-item.read workers-r2-bucket-item.write workers-scripts.write account-analytics.read offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(pending.codeVerifier).digest('base64url'));
  assert.equal(url.searchParams.get('state'), pending.state);
  // The verifier is what makes an intercepted code useless; it must not travel.
  assert.ok(!pending.url.includes(pending.codeVerifier));
  assert.deepEqual(decodeState(pending.state)?.returnOrigin, 'https://my-tunnel.trycloudflare.com');
});

test('a redirect that is neither HTTPS nor loopback HTTP is refused', () => {
  assert.throws(() => createAuthorization({ ...SETTINGS, redirectUri: 'http://stm.example.com/callback' }, 'http://127.0.0.1:7860'), (error: unknown) => error instanceof CloudflareOAuthError && error.code === 'oauth_not_configured');
  assert.doesNotThrow(() => createAuthorization({ ...SETTINGS, redirectUri: 'http://127.0.0.1:7860/api/v1/r2/cloudflare/callback' }, 'http://127.0.0.1:7860'));
  assert.throws(() => createAuthorization({ ...SETTINGS, clientId: ' ' }, 'http://127.0.0.1:7860'), /client ID/u);
});

test('a callback is matched only to the state issued, and only for ten minutes', () => {
  const pending = createAuthorization(SETTINGS, 'http://127.0.0.1:7860', 1_000);
  assert.equal(matchesPending(pending, pending.state, 1_000 + AUTHORIZATION_TTL_MS), true);
  assert.equal(matchesPending(pending, pending.state, 1_001 + AUTHORIZATION_TTL_MS), false);
  assert.equal(matchesPending(pending, `${pending.state}x`, 2_000), false);
  assert.equal(matchesPending(null, pending.state, 2_000), false);
});

test('decodeState rejects what the manager did not write', () => {
  assert.equal(decodeState('not-base64-json'), null);
  assert.equal(decodeState(Buffer.from('{"n":1}').toString('base64url')), null);
});

test('the code is exchanged with the verifier and no client secret', async () => {
  const pending = createAuthorization(SETTINGS, 'http://127.0.0.1:7860', 0);
  const { fetchImpl, calls } = recordingFetch(() => Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'bearer', scope: 'workers-r2.read workers-r2.write offline_access' }));
  const grant = await exchangeCode(SETTINGS, pending, 'code-1', { fetchImpl, now: () => 10_000 });
  assert.deepEqual(grant, { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 10_000 + 3_600_000, scopes: ['workers-r2.read', 'workers-r2.write', 'offline_access'] });
  assert.equal(calls[0]?.url, CLOUDFLARE_OAUTH.token);
  assert.equal(calls[0]?.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(calls[0]?.body ?? []), { grant_type: 'authorization_code', code: 'code-1', redirect_uri: SETTINGS.redirectUri, client_id: 'client-123', code_verifier: pending.codeVerifier });
});

test('a refresh keeps the old refresh token when none is returned, and takes a rotated one', async () => {
  const kept = await refreshGrant(SETTINGS, 'refresh-1', { fetchImpl: recordingFetch(() => Response.json({ access_token: 'access-2', token_type: 'Bearer' })).fetchImpl });
  assert.equal(kept.refreshToken, 'refresh-1');
  assert.equal(kept.expiresAt, null);
  // No scope in the response means what was asked for (RFC 6749 §5.1).
  assert.deepEqual(kept.scopes, SETTINGS.scopes);
  const rotated = await refreshGrant(SETTINGS, 'refresh-1', { fetchImpl: recordingFetch(() => Response.json({ access_token: 'access-3', refresh_token: 'refresh-2' })).fetchImpl });
  assert.equal(rotated.refreshToken, 'refresh-2');
});

test('a revoked grant is told apart from other token failures, without echoing the token', async () => {
  const revoked = recordingFetch(() => Response.json({ error: 'invalid_grant', error_description: 'The refresh token refresh-secret is revoked' }, { status: 400 }));
  await assert.rejects(refreshGrant(SETTINGS, 'refresh-secret', { fetchImpl: revoked.fetchImpl }), (error: unknown) => error instanceof CloudflareOAuthError && error.code === 'oauth_grant_revoked');
  const broken = recordingFetch(() => new Response('upstream down', { status: 502 }));
  await assert.rejects(refreshGrant(SETTINGS, 'refresh-secret', { fetchImpl: broken.fetchImpl }), (error: unknown) => error instanceof CloudflareOAuthError && error.code === 'oauth_refresh_failed' && !error.message.includes('upstream'));
  const empty = recordingFetch(() => Response.json({ token_type: 'bearer' }));
  await assert.rejects(exchangeCode(SETTINGS, createAuthorization(SETTINGS, 'http://127.0.0.1:7860'), 'code', { fetchImpl: empty.fetchImpl }), /without an access token/u);
});

test('revoking posts the token to the revocation endpoint and fails loudly on an error', async () => {
  const ok = recordingFetch(() => new Response(null, { status: 200 }));
  await revokeToken('client-123', 'refresh-1', { fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls[0]?.url, CLOUDFLARE_OAUTH.revoke);
  assert.deepEqual(Object.fromEntries(ok.calls[0]?.body ?? []), { token: 'refresh-1', client_id: 'client-123' });
  const failed = recordingFetch(() => Response.json({ error: 'server_error' }, { status: 500 }));
  await assert.rejects(revokeToken('client-123', 'refresh-1', { fetchImpl: failed.fetchImpl }), (error: unknown) => error instanceof CloudflareOAuthError && error.code === 'oauth_revoke_failed');
});
