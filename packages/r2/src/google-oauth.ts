import { AUTHORIZATION_TTL_MS, createPkcePair, encodeState, matchesPending, type PendingAuthorization } from '../../cloudflare/src/index.js';
import { R2Error } from './store.js';

/**
 * Signing in to Google for Drive backups.
 *
 * Google's web OAuth clients want the client secret at the code exchange and at
 * every refresh, and nothing the manager ships can hold one: the repository is
 * public, and the npm package and the APK can be read back out. So both token
 * requests go to the project's token broker, which adds the secret and passes
 * them on to Google (`deploy/oauth-relay/src/broker.ts`). Only tokens travel
 * that way; files go from the manager to Drive directly.
 *
 * The browser part is the same as Cloudflare's: a PKCE challenge, a `state`
 * carrying the manager's own origin, and the relay page on the project's
 * domain sending the browser back to whichever manager started the sign-in.
 */

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/**
 * Only the app's own hidden folder in the Drive.
 *
 * Nothing else in the Drive can be seen with it, and what is in it cannot be
 * seen, moved or deleted by hand in Drive either, which is the point: a
 * backup is thousands of files nobody should tidy away by accident. The space
 * it takes still counts against the account's storage, and the account owner
 * can empty it from Drive's settings (Manage apps).
 */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

export { AUTHORIZATION_TTL_MS, matchesPending, type PendingAuthorization };

export interface GoogleClientSettings {
  readonly clientId: string;
  /** The relay page registered on the client, e.g. `https://<site>/oauth/google/callback`. */
  readonly redirectUri: string;
  /** The broker's origin; its routes are `/api/google/token` and `/api/google/refresh`. */
  readonly brokerUrl: string;
}

export interface GoogleGrant {
  readonly accessToken: string;
  /** Google sends one on the first consent; `prompt=consent` asks for it every time. */
  readonly refreshToken: string | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

export function createGoogleAuthorization(settings: GoogleClientSettings, returnOrigin: string, now: number = Date.now()): PendingAuthorization {
  const { verifier, challenge } = createPkcePair();
  const state = encodeState(returnOrigin);
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('scope', GOOGLE_DRIVE_SCOPE);
  // A refresh token, so backups go on after the first hour...
  url.searchParams.set('access_type', 'offline');
  // ...and every time: Google sends one only on the first consent otherwise,
  // so reconnecting on a second machine would come back without one.
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, codeVerifier: verifier, createdAt: now };
}

export async function exchangeGoogleCode(settings: GoogleClientSettings, pending: PendingAuthorization, code: string, options: { fetchImpl: typeof fetch; now: () => number }): Promise<GoogleGrant> {
  if (!code) throw new R2Error('google_missing_code', 'Google did not send an authorization code back');
  return await brokerRequest(settings, '/api/google/token', { code, code_verifier: pending.codeVerifier }, options);
}

export async function refreshGoogleGrant(settings: GoogleClientSettings, refreshToken: string, options: { fetchImpl: typeof fetch; now: () => number }): Promise<GoogleGrant> {
  return await brokerRequest(settings, '/api/google/refresh', { refresh_token: refreshToken }, options);
}

/** Revoke the grant at Google. No secret is needed for this, so it goes direct. */
export async function revokeGoogleToken(token: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  // 400 is Google saying the token is already not valid, which is the goal.
  if (!response.ok && response.status !== 400) throw new R2Error('google_revoke_failed', `Google did not revoke the sign-in (${response.status})`);
}

async function brokerRequest(settings: GoogleClientSettings, path: string, body: Record<string, string>, options: { fetchImpl: typeof fetch; now: () => number }): Promise<GoogleGrant> {
  let response: Response;
  try {
    response = await options.fetchImpl(new URL(path, settings.brokerUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    throw new R2Error('google_broker_unreachable', `The sign-in service could not be reached: ${error instanceof Error ? error.message : 'network error'}`);
  }
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = await response.json();
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    // Read as an empty answer below.
  }
  if (!response.ok) {
    const error = typeof parsed.error === 'string' ? parsed.error : '';
    // invalid_grant is Google's word for a refresh token that was revoked,
    // expired, or belongs to a client that no longer exists.
    if (error === 'invalid_grant') throw new R2Error('google_grant_revoked', 'Google no longer accepts this sign-in. Connect Google Drive again.');
    if (response.status === 429) throw new R2Error('google_broker_busy', 'The sign-in service is busy. Try again in a minute.');
    if (error === 'broker_not_configured' || error === 'signin_paused' || response.status >= 500) {
      throw new R2Error('google_broker_unavailable', `The sign-in service is not available right now (${error || response.status}).`);
    }
    const description = typeof parsed.error_description === 'string' ? `: ${parsed.error_description}` : '';
    throw new R2Error('google_token_failed', `Google refused the sign-in (${error || response.status})${description}`);
  }
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new R2Error('google_token_failed', 'Google answered without an access token');
  const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : null,
    expiresAt: options.now() + expiresIn * 1000,
    scopes: typeof parsed.scope === 'string' ? parsed.scope.split(/\s+/u).filter(Boolean) : [],
  };
}

/** Whether a pending sign-in has run out of time. */
export function pendingExpired(pending: PendingAuthorization, now: number): boolean {
  return now - pending.createdAt > AUTHORIZATION_TTL_MS;
}
