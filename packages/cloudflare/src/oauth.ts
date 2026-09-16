import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Cloudflare's OAuth endpoints, from https://dash.cloudflare.com/.well-known/openid-configuration. */
export const CLOUDFLARE_OAUTH = {
  authorize: 'https://dash.cloudflare.com/oauth2/auth',
  token: 'https://dash.cloudflare.com/oauth2/token',
  revoke: 'https://dash.cloudflare.com/oauth2/revoke',
} as const;

/**
 * How long an authorization request stays answerable.
 *
 * Long enough to sign in, pick an account and read the consent screen; short
 * enough that a `state` left in browser history is worth nothing.
 */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/**
 * Scope IDs for the grant.
 *
 * Cloudflare names OAuth scopes after API token permissions. These were
 * checked against a registered client on 2026-09-16: an unregistered ID is
 * refused with `invalid_scope` before the user even signs in. The R2 scopes
 * alone are enough for `GET /accounts` to return the account the user chose.
 * The server lets `STM_CLOUDFLARE_OAUTH_SCOPES` replace them.
 */
export const DEFAULT_SCOPES = {
  /** List and create buckets, and read account-level R2 metrics. */
  r2Read: 'workers-r2.read',
  r2Write: 'workers-r2.write',
  /** Objects inside a bucket, over the REST object endpoints. */
  bucketItemRead: 'workers-r2-bucket-item.read',
  bucketItemWrite: 'workers-r2-bucket-item.write',
  /**
   * Deploy the Worker that carries backup data to the bucket. Optional on the
   * client: declined, every transfer goes over the REST API instead.
   *
   * OAuth clients cannot be granted API token permissions, so this is the only
   * way to a data path that does not spend the user's API rate limit.
   */
  workersScriptsWrite: 'workers-scripts.write',
  /** Class A/B operations and storage from GraphQL. Optional on the client. */
  analyticsRead: 'account-analytics.read',
} as const;

export interface OAuthClientSettings {
  readonly clientId: string;
  readonly redirectUri: string;
  /**
   * Every scope to ask for. Which of them the user may decline is set on the
   * client registration, not here; what was granted comes back on the token.
   */
  readonly scopes: readonly string[];
}

/** One sign-in in progress. The verifier never leaves the manager. */
export interface PendingAuthorization {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
}

/** What a token response grants, with the expiry turned into a time. */
export interface OAuthGrant {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch milliseconds, or null when Cloudflare did not say. */
  readonly expiresAt: number | null;
  /** What was actually granted, which may be less than was asked for. */
  readonly scopes: readonly string[];
}

export class CloudflareOAuthError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function createPkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes is 43 base64url characters, the shortest verifier allowed.
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}

/**
 * The `state` for one sign-in: a nonce, and the origin to send the browser back to.
 *
 * The client is registered with a single redirect on the publisher's domain,
 * which cannot know whether the manager was opened on this machine, over the
 * LAN or through a tunnel. The relay reads the origin from here. It is not a
 * secret and not trusted: the callback only accepts a state it issued itself.
 */
export function encodeState(returnOrigin: string): string {
  const origin = new URL(returnOrigin).origin;
  return Buffer.from(JSON.stringify({ n: randomBytes(16).toString('base64url'), o: origin }), 'utf8').toString('base64url');
}

export function decodeState(state: string): { nonce: string; returnOrigin: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    if (!isRecord(parsed) || typeof parsed.n !== 'string' || typeof parsed.o !== 'string') return null;
    return { nonce: parsed.n, returnOrigin: new URL(parsed.o).origin };
  } catch {
    return null;
  }
}

export function createAuthorization(settings: OAuthClientSettings, returnOrigin: string, now: number = Date.now()): PendingAuthorization {
  validateSettings(settings);
  const { verifier, challenge } = createPkcePair();
  const state = encodeState(returnOrigin);
  const url = new URL(CLOUDFLARE_OAUTH.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  // offline_access is what makes Cloudflare issue a refresh token; without it
  // the connection would end with the first access token.
  url.searchParams.set('scope', withOfflineAccess(settings.scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, codeVerifier: verifier, createdAt: now };
}

/** Whether a pending sign-in is still the one to finish, compared in constant time. */
export function matchesPending(pending: PendingAuthorization | null, state: string, now: number = Date.now()): pending is PendingAuthorization {
  if (!pending || now - pending.createdAt > AUTHORIZATION_TTL_MS) return false;
  const expected = Buffer.from(pending.state, 'utf8');
  const received = Buffer.from(state, 'utf8');
  return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
}

export async function exchangeCode(settings: OAuthClientSettings, pending: PendingAuthorization, code: string, options: TokenRequestOptions = {}): Promise<OAuthGrant> {
  if (!code) throw new CloudflareOAuthError('oauth_missing_code', 'Cloudflare did not return an authorization code');
  return await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: settings.redirectUri,
    client_id: settings.clientId,
    code_verifier: pending.codeVerifier,
  }, settings.scopes, null, options);
}

/**
 * Trade the refresh token for a new access token.
 *
 * Cloudflare may rotate the refresh token as it does so. The new one replaces
 * the old; when none comes back, the old one is still the one to keep.
 */
export async function refreshGrant(settings: Pick<OAuthClientSettings, 'clientId' | 'scopes'>, refreshToken: string, options: TokenRequestOptions = {}): Promise<OAuthGrant> {
  return await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: settings.clientId }, settings.scopes, refreshToken, options);
}

/** Revoke a token (RFC 7009). Revoking the refresh token ends the whole grant. */
export async function revokeToken(clientId: string, token: string, options: TokenRequestOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(CLOUDFLARE_OAUTH.revoke, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ token, client_id: clientId }).toString(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  // RFC 7009: an unknown or already revoked token is still a 200. Anything
  // else means the grant may still be alive, which the caller has to know.
  if (!response.ok) throw await oauthError(response, 'oauth_revoke_failed');
}

export interface TokenRequestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

async function tokenRequest(body: Record<string, string>, requestedScopes: readonly string[], previousRefreshToken: string | null, options: TokenRequestOptions): Promise<OAuthGrant> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const response = await fetchImpl(CLOUDFLARE_OAUTH.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await oauthError(response, body.grant_type === 'refresh_token' ? 'oauth_refresh_failed' : 'oauth_exchange_failed');
  const parsed: unknown = await response.json().catch(() => null);
  if (!isRecord(parsed) || typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new CloudflareOAuthError('oauth_invalid_token_response', 'Cloudflare returned a token response without an access token');
  }
  if (typeof parsed.token_type === 'string' && parsed.token_type.toLowerCase() !== 'bearer') {
    throw new CloudflareOAuthError('oauth_invalid_token_response', `Cloudflare returned an unsupported token type: ${parsed.token_type}`);
  }
  const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) && parsed.expires_in > 0 ? parsed.expires_in : null;
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : previousRefreshToken,
    expiresAt: expiresIn === null ? null : now() + expiresIn * 1000,
    // RFC 6749 §5.1: an absent scope means exactly what was requested.
    scopes: typeof parsed.scope === 'string' ? parsed.scope.split(/\s+/u).filter(Boolean) : [...requestedScopes],
  };
}

/**
 * Turn an OAuth error response into something to show.
 *
 * Only the error code and its description are kept. The body of a failed token
 * request can echo what was sent, and that includes the code or refresh token.
 */
async function oauthError(response: Response, code: string): Promise<CloudflareOAuthError> {
  const parsed: unknown = await response.json().catch(() => null);
  const error = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : null;
  const description = isRecord(parsed) && typeof parsed.error_description === 'string' ? parsed.error_description.slice(0, 300) : null;
  // invalid_grant is the one answer that means signing in again is the only fix.
  const finalCode = error === 'invalid_grant' ? 'oauth_grant_revoked' : code;
  return new CloudflareOAuthError(finalCode, `Cloudflare OAuth request failed (${response.status})${error ? `: ${error}` : ''}${description ? ` - ${description}` : ''}`);
}

function withOfflineAccess(scopes: readonly string[]): string[] {
  return scopes.includes('offline_access') ? [...scopes] : [...scopes, 'offline_access'];
}

function validateSettings(settings: OAuthClientSettings): void {
  if (!settings.clientId.trim()) throw new CloudflareOAuthError('oauth_not_configured', 'No Cloudflare OAuth client ID is configured');
  let redirect: URL;
  try { redirect = new URL(settings.redirectUri); } catch { throw new CloudflareOAuthError('oauth_not_configured', 'The Cloudflare OAuth redirect URI is not a valid URL'); }
  const loopback = redirect.hostname === '127.0.0.1' || redirect.hostname === 'localhost' || redirect.hostname === '[::1]';
  if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback)) {
    throw new CloudflareOAuthError('oauth_not_configured', 'The Cloudflare OAuth redirect URI must use HTTPS, or HTTP on a loopback address');
  }
  if (settings.scopes.length === 0) throw new CloudflareOAuthError('oauth_not_configured', 'No Cloudflare OAuth scopes are configured');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
