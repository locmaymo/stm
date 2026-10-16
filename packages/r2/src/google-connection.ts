import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GoogleConnectionState, GoogleConnectionStatus } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';
import { DRIVE_API, DriveObjectStore } from './drive-store.js';
import {
  createGoogleAuthorization,
  exchangeGoogleCode,
  GOOGLE_DRIVE_SCOPE,
  matchesPending,
  pendingExpired,
  refreshGoogleGrant,
  revokeGoogleToken,
  type GoogleClientSettings,
  type PendingAuthorization,
} from './google-oauth.js';
import { R2Error, type ObjectStore } from './store.js';

export type { GoogleConnectionState, GoogleConnectionStatus };

const CONNECTION_FILE = 'google-connection.json';
const SCHEMA_VERSION = 1 as const;
/** Refresh this long before Google says the access token ends. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;
/** How long a reading of the Drive's free space is shown before it is read again. */
const STORAGE_TTL_MS = 15 * 60 * 1000;
const PENDING_SIGN_IN_LIMIT = 4;
/** What the backups are called where a bucket name would be shown. */
export const DRIVE_TARGET_LABEL = 'Google Drive';
/** Said to a manager connected before backups moved into the hidden app folder. */
const MOVED_TO_APP_FOLDER = 'Backups now go to a hidden folder only this app can see. Connect Google Drive again to allow it.';

/**
 * What a sign-in with Google was started for: arranging backups from inside
 * the console, or opening the console with Google instead of a password.
 * Held here, not in the state Google hands back, so a browser cannot edit it.
 */
export type GooglePurpose = 'connect' | 'signIn';

/** The Google account behind a connection; `id` is Drive's stable user id. */
export interface GoogleAccount {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
}

interface PendingSignIn {
  readonly authorization: PendingAuthorization;
  readonly purpose: GooglePurpose;
  readonly startedBy?: string;
}

interface StoredConnection {
  readonly schemaVersion: 1;
  /** Names this installation in the claim. Not a secret; stable across reconnects. */
  readonly installationKeyId: string;
  /** The one long-lived secret. */
  readonly refreshToken: string | null;
  readonly account: GoogleAccount | null;
  /** The Drive scope the grant holds; a grant without the current one has to be given again. */
  readonly scope: string | null;
  readonly connectedAt: string | null;
  readonly reconnectRequired: boolean;
  readonly lastError: string | null;
  /** The machine this manager handed the Drive to; see `surrender`. */
  readonly displacedBy: string | null;
}

export interface GoogleConnectionOptions {
  readonly paths: PlatformPaths;
  readonly client: GoogleClientSettings;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * A Google Drive connected by signing in with Google.
 *
 * Holds the grant and hands the backup code an object store on the app's
 * hidden folder in the Drive (`appDataFolder`). Tokens are refreshed through the project's token
 * broker, which holds the client secret; see `google-oauth.ts`.
 */
export class GoogleConnection {
  private readonly paths: PlatformPaths;
  private readonly client: GoogleClientSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: ((milliseconds: number) => Promise<void>) | undefined;
  private stored: StoredConnection | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private pending: PendingSignIn[] = [];
  private accessToken: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private storage: { readonly at: number; readonly usedBytes: number; readonly limitBytes: number | null; readonly backupBytes?: number; readonly backupFiles?: number } | null = null;
  /** One store per connection, so the listing it keeps outlives a single call. */
  private store: DriveObjectStore | null = null;

  public constructor(options: GoogleConnectionOptions) {
    this.paths = options.paths;
    this.client = options.client;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep;
  }

  public async status(): Promise<GoogleConnectionStatus> {
    const stored = await this.load();
    const state: GoogleConnectionState = stored.reconnectRequired ? 'reconnect_required' : stored.refreshToken && stored.scope === GOOGLE_DRIVE_SCOPE ? 'connected' : 'disconnected';
    return {
      state,
      email: stored.account?.email ?? null,
      name: stored.account?.name ?? null,
      connectedAt: stored.connectedAt,
      lastError: stored.lastError,
      displacedBy: stored.displacedBy,
      storage: state === 'connected' && this.storage ? {
        usedBytes: this.storage.usedBytes,
        limitBytes: this.storage.limitBytes,
        backupBytes: this.storage.backupBytes ?? null,
        backupFiles: this.storage.backupFiles ?? null,
        readAt: new Date(this.storage.at).toISOString(),
      } : null,
    };
  }

  public async usable(): Promise<boolean> {
    return (await this.status()).state === 'connected';
  }

  /** Start a sign-in; the answer comes back to `completeConnect` through the relay page. */
  public beginConnect(returnOrigin: string, startedBy?: string, purpose: GooglePurpose = 'connect'): string {
    const authorization = createGoogleAuthorization(this.client, returnOrigin, this.now());
    this.prunePending().push({ authorization, purpose, ...(startedBy ? { startedBy } : {}) });
    while (this.pending.length > PENDING_SIGN_IN_LIMIT) this.pending.shift();
    return authorization.url;
  }

  /** Whether this callback belongs to a sign-in started here and still in time. */
  public isPending(state: string): boolean {
    return this.findPending(state) !== undefined;
  }

  /** What the sign-in this callback belongs to was started for, if it is one of ours. */
  public pendingPurpose(state: string): GooglePurpose | null {
    return this.findPending(state)?.purpose ?? null;
  }

  /** The console session that started this sign-in, if one did. */
  public pendingStartedBy(state: string): string | null {
    return this.findPending(state)?.startedBy ?? null;
  }

  /**
   * Finish signing in with what Google sent back.
   *
   * `accept` is asked who signed in before anything is kept. Refused, the new
   * grant is revoked and this manager's own connection is left exactly as it
   * was: a stranger signing in on the login page must not replace the owner's
   * Drive with theirs, or sign the owner out by trying.
   *
   * Google lets the person untick the Drive permission on its page and still
   * sends a code back; that grant is no use for backups and is refused here
   * rather than failing at the first upload.
   */
  public async completeConnect(callback: { state: string; code?: string | null; error?: string | null }, options: { readonly accept?: (account: GoogleAccount) => Promise<boolean> } = {}): Promise<GoogleConnectionStatus> {
    const index = this.prunePending().findIndex((entry) => matchesPending(entry.authorization, callback.state, this.now()));
    const entry = index === -1 ? null : this.pending.splice(index, 1)[0] ?? null;
    if (!entry) throw new R2Error('google_state_mismatch', 'This sign-in link has expired or was not started here. Connect again.');
    if (callback.error) {
      throw new R2Error('google_authorization_denied', callback.error === 'access_denied' ? 'Access to Google Drive was not granted.' : `Google refused the sign-in: ${callback.error}`);
    }
    const grant = await exchangeGoogleCode(this.client, entry.authorization, callback.code ?? '', { fetchImpl: this.fetchImpl, now: this.now });
    if (!grant.refreshToken) throw new R2Error('google_no_refresh_token', 'Google did not issue a lasting sign-in. Connect again.');
    if (grant.scopes.length > 0 && !grant.scopes.includes(GOOGLE_DRIVE_SCOPE)) {
      await revokeGoogleToken(grant.refreshToken, this.fetchImpl).catch(() => undefined);
      throw new R2Error('google_scope_missing', 'Google Drive access was not ticked on the Google page. Connect again and leave it ticked.');
    }
    // Who this is, asked with the new token alone, before anything is kept.
    const about = await this.readAbout(grant.accessToken);
    if (!about.account.id) throw new R2Error('google_account_unknown', 'Google did not say which account signed in');
    if (options.accept && !await options.accept(about.account)) {
      await revokeGoogleToken(grant.refreshToken, this.fetchImpl).catch(() => undefined);
      throw new R2Error('google_not_owner', 'This manager belongs to another Google account');
    }
    this.accessToken = { value: grant.accessToken, expiresAt: grant.expiresAt };
    this.store = null;
    const previous = await this.load();
    await this.save({ ...previous, refreshToken: grant.refreshToken, account: about.account, scope: GOOGLE_DRIVE_SCOPE, reconnectRequired: false, lastError: null, displacedBy: null, connectedAt: new Date(this.now()).toISOString() });
    return await this.status();
  }

  /**
   * Sign out: the grant is forgotten here, and revoked at Google unless told not to.
   *
   * Google revokes the whole grant, not one machine's token: every machine
   * signed in to this Drive with this app loses it at once. So the caller
   * leaves it in place when another machine is the one backing up.
   *
   * The files stay in the Drive. Forgotten whatever Google answers, because the
   * user asked for it to be gone.
   */
  public async disconnect(options: { readonly revoke?: boolean } = {}): Promise<{ revoked: boolean }> {
    const stored = await this.load();
    const revoked = stored.refreshToken && options.revoke !== false ? await revokeGoogleToken(stored.refreshToken, this.fetchImpl).then(() => true, () => false) : false;
    this.accessToken = null;
    this.pending = [];
    this.storage = null;
    this.store = null;
    await this.save({ ...stored, refreshToken: null, account: null, scope: null, connectedAt: null, reconnectRequired: false, lastError: null, displacedBy: null });
    return { revoked };
  }

  /** Give the Drive up, because another machine signed in with it; see R2Manager's claim. */
  public async surrender(by: string, reason: string): Promise<boolean> {
    const stored = await this.load();
    if (!stored.refreshToken) return false;
    this.accessToken = null;
    this.refreshing = null;
    this.pending = [];
    this.store = null;
    await this.save({ ...stored, refreshToken: null, reconnectRequired: true, lastError: reason.slice(0, 500), displacedBy: by.slice(0, 120) });
    return true;
  }

  public async installationId(): Promise<string> {
    return (await this.load()).installationKeyId;
  }

  /** The account connected, for recording who may open this manager. */
  public async account(): Promise<GoogleAccount | null> {
    return (await this.load()).account;
  }

  /** Where backups go, as the chunk ledger names it: one app folder per Google account. */
  public async target(): Promise<{ email: string | null; accountId: string } | null> {
    const stored = await this.load();
    return stored.refreshToken && stored.scope === GOOGLE_DRIVE_SCOPE && !stored.reconnectRequired ? { email: stored.account?.email ?? null, accountId: stored.account?.id ?? '' } : null;
  }

  public objectStore(): ObjectStore {
    return this.driveStore();
  }

  /**
   * Remove every file this app keeps in the Drive, for "delete the backups
   * too" when disconnecting. The app folder is the app's own, so this is all
   * of the backups and nothing else.
   */
  public async deleteBackups(): Promise<{ readonly files: number; readonly bytes: number }> {
    return await this.driveStore().deleteEverything();
  }

  private driveStore(): DriveObjectStore {
    if (this.store) return this.store;
    this.store = new DriveObjectStore({
      token: async () => await this.token(),
      invalidate: () => { this.accessToken = null; },
      ready: async () => {
        const stored = await this.load();
        if (stored.reconnectRequired) throw new R2Error('google_reconnect_required', 'Reconnect Google Drive to continue backing up');
        if (!stored.refreshToken || stored.scope !== GOOGLE_DRIVE_SCOPE) throw new R2Error('r2_not_configured', 'Connect Google Drive first');
      },
      fetchImpl: this.fetchImpl,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    });
    return this.store;
  }

  /** The Drive's used and total space, and what the backups take of it, read again when the last reading is old. */
  public async refreshStorage(options: { readonly force?: boolean } = {}): Promise<void> {
    if (!await this.usable()) return;
    if (!options.force && this.storage && this.now() - this.storage.at < STORAGE_TTL_MS) return;
    try {
      await this.readAbout();
      // From the listing the store keeps; one listing when it has none yet.
      const backups = await this.driveStore().storedBytes();
      if (this.storage) this.storage = { ...this.storage, backupBytes: backups.bytes, backupFiles: backups.files };
    } catch (error: unknown) {
      await this.recordError(error instanceof Error ? error.message : 'Google Drive could not be read');
    }
  }

  /** The account and its space; with `accessToken`, asked with that token rather than the connection's. */
  private async readAbout(accessToken?: string): Promise<{ account: GoogleAccount }> {
    const url = `${DRIVE_API}/about?fields=${encodeURIComponent('user(emailAddress,displayName,permissionId),storageQuota(limit,usage)')}`;
    const response = accessToken
      ? await this.fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } })
      : await this.drive(url, { method: 'GET' });
    if (!response.ok) throw new R2Error('google_drive_failed', `Google Drive answered ${response.status}`);
    const about = await response.json() as { user?: { emailAddress?: unknown; displayName?: unknown; permissionId?: unknown }; storageQuota?: { limit?: unknown; usage?: unknown } };
    const used = Number(about.storageQuota?.usage ?? Number.NaN);
    const limit = about.storageQuota?.limit === undefined ? null : Number(about.storageQuota.limit);
    if (Number.isFinite(used)) this.storage = { at: this.now(), usedBytes: used, limitBytes: limit !== null && Number.isFinite(limit) ? limit : null };
    const email = typeof about.user?.emailAddress === 'string' ? about.user.emailAddress : '';
    const id = typeof about.user?.permissionId === 'string' ? about.user.permissionId : '';
    return { account: { id, email, name: typeof about.user?.displayName === 'string' ? about.user.displayName : null } };
  }

  /** A Drive API call outside the object store (folders, account), refreshing once on 401. */
  private async drive(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.token();
      const response = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
      if (response.ok) return response;
      if (response.status === 401 && attempt === 0) { this.accessToken = null; continue; }
      throw new R2Error('google_drive_failed', `Google Drive answered ${response.status}`);
    }
  }

  private async token(): Promise<string> {
    const current = this.accessToken;
    if (current && this.now() < current.expiresAt - ACCESS_TOKEN_MARGIN_MS) return current.value;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const stored = await this.load();
        if (!stored.refreshToken || stored.reconnectRequired) throw new R2Error('google_reconnect_required', 'Reconnect Google Drive to continue backing up');
        try {
          const grant = await refreshGoogleGrant(this.client, stored.refreshToken, { fetchImpl: this.fetchImpl, now: this.now });
          if (grant.refreshToken && grant.refreshToken !== stored.refreshToken) await this.save({ ...(await this.load()), refreshToken: grant.refreshToken });
          this.accessToken = { value: grant.accessToken, expiresAt: grant.expiresAt };
          return grant.accessToken;
        } catch (error: unknown) {
          if (error instanceof R2Error && error.code === 'google_grant_revoked') {
            await this.save({ ...(await this.load()), reconnectRequired: true, lastError: 'Google no longer accepts this sign-in. It was revoked or expired; connect again.' });
            throw new R2Error('google_reconnect_required', 'Google no longer accepts this sign-in. Reconnect Google Drive to continue backing up.');
          }
          throw error;
        }
      })().finally(() => { this.refreshing = null; });
    }
    return await this.refreshing;
  }

  private findPending(state: string): PendingSignIn | undefined {
    return this.prunePending().find((entry) => matchesPending(entry.authorization, state, this.now()));
  }

  private prunePending(): PendingSignIn[] {
    const now = this.now();
    this.pending = this.pending.filter((entry) => !pendingExpired(entry.authorization, now));
    return this.pending;
  }

  private async recordError(message: string): Promise<void> {
    await this.save({ ...(await this.load()), lastError: message.slice(0, 500) });
  }

  private async load(): Promise<StoredConnection> {
    if (this.stored) return this.stored;
    try {
      this.stored = parseStored(JSON.parse(await readFile(join(this.paths.state, CONNECTION_FILE), 'utf8')));
    } catch (error: unknown) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      await this.save({
        schemaVersion: SCHEMA_VERSION,
        installationKeyId: randomBytes(8).toString('hex'),
        refreshToken: null,
        account: null,
        scope: null,
        connectedAt: null,
        reconnectRequired: false,
        lastError: null,
        displacedBy: null,
      });
    }
    if (!this.stored) throw new Error('Google connection state could not be loaded');
    return this.stored;
  }

  /** Written whole to a temporary file and renamed over, readable only by this user. */
  private async save(next: StoredConnection): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, CONNECTION_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, target);
      } catch (error: unknown) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.stored = next;
    };
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }
}

function parseStored(value: unknown): StoredConnection {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.installationKeyId !== 'string' || !/^[a-z0-9]{8,64}$/u.test(value.installationKeyId)) {
    throw new Error('Unsupported Google connection state');
  }
  const account = isRecord(value.account) && typeof value.account.email === 'string'
    ? { id: typeof value.account.id === 'string' ? value.account.id : '', email: value.account.email, name: typeof value.account.name === 'string' ? value.account.name : null }
    : null;
  const refreshToken = typeof value.refreshToken === 'string' && value.refreshToken ? value.refreshToken : null;
  const scope = typeof value.scope === 'string' ? value.scope : null;
  // Connected before backups moved into the app folder: that grant cannot reach it.
  const outdated = refreshToken !== null && scope !== GOOGLE_DRIVE_SCOPE;
  return {
    schemaVersion: SCHEMA_VERSION,
    installationKeyId: value.installationKeyId,
    refreshToken,
    account,
    scope,
    connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : null,
    reconnectRequired: value.reconnectRequired === true || outdated,
    lastError: outdated ? MOVED_TO_APP_FOLDER : typeof value.lastError === 'string' ? value.lastError : null,
    displacedBy: typeof value.displacedBy === 'string' ? value.displacedBy : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
