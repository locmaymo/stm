import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BackupWorker,
  CloudflareApi,
  CloudflareApiError,
  CloudflareOAuthError,
  AUTHORIZATION_TTL_MS,
  createAuthorization,
  DEFAULT_SCOPES,
  exchangeCode,
  isR2NotEnabled,
  matchesPending,
  refreshGrant,
  revokeToken,
  type CloudflareAccount,
  type OAuthClientSettings,
  type PendingAuthorization,
  type R2Jurisdiction,
  type WorkerSession,
} from '../../cloudflare/src/index.js';
import type { CloudflareAccountProblem, CloudflareConnectionState, CloudflareConnectionStatus } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';
import { RequestPacer, RestObjectStore } from './rest.js';
import { R2Error, R2HttpError, type Billing, type ObjectRecord, type ObjectStore } from './store.js';
import { WorkerObjectStore } from './worker-store.js';

const CONNECTION_FILE = 'cloudflare-connection.json';
const SCHEMA_VERSION = 1 as const;
/** Refresh this long before Cloudflare says the access token ends, so a request never races it. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;
/** After the Worker could not be used, how long the REST API carries the data before trying again. */
const WORKER_RETRY_MS = 60 * 60 * 1000;
/** After a rotation failed, how long the current key is used before trying again. */
const ROTATION_RETRY_MS = 10 * 60 * 1000;
/**
 * How many sign-ins may be on their way to Cloudflare at once.
 *
 * More than one, because a console that can be reached at more than one
 * address is usually open at more than one of them: the machine it runs on,
 * and the link that was opened so a phone could reach it too. There was a
 * single slot here, so pressing the Cloudflare button in the second tab
 * cancelled the first - and the first tab came back from Cloudflare to "this
 * sign-in was started somewhere else" while the second was let in. What that
 * looks like from the desk is a console refusing the address it is being read
 * at and accepting the one on the phone, at random.
 *
 * Small, because each is a live authorization and each expires on its own
 * within ten minutes. Oldest out first when the room runs out.
 */
const PENDING_SIGN_IN_LIMIT = 4;

/** One sign-in on its way to Cloudflare, and what it was started for. */
interface PendingSignIn {
  readonly authorization: PendingAuthorization;
  readonly purpose: CloudflarePurpose;
  /** The console session that started it, where one did; see `beginConnect`. */
  readonly startedBy?: string;
}

export type CloudflareDataPath = 'worker' | 'rest';
/** What a sign-in with Cloudflare was started for; see `beginConnect`. */
export type CloudflarePurpose = 'connect' | 'signIn';
export type { CloudflareConnectionState, CloudflareConnectionStatus };

interface StoredConnection {
  readonly schemaVersion: 1;
  /** Names this installation's Worker key. Not a secret; stable across reconnects. */
  readonly installationKeyId: string;
  /** The one long-lived secret. Replaced on disk before a rotated token is used. */
  readonly refreshToken: string | null;
  readonly scopes: readonly string[];
  readonly account: CloudflareAccount | null;
  readonly bucket: { readonly name: string; readonly jurisdiction: R2Jurisdiction } | null;
  readonly connectedAt: string | null;
  readonly reconnectRequired: boolean;
  readonly lastError: string | null;
  /** Set when Cloudflare refused for a reason the account owner has to fix there. */
  readonly problem: CloudflareAccountProblem | null;
  /** The machine this manager handed the account to; see `surrender`. */
  readonly displacedBy: string | null;
}

/**
 * A bucket this manager already backs up to by other means, such as S3 keys.
 *
 * Signing in to the same account should carry on in that bucket, where the
 * recovery points already are, rather than start again in a new one.
 */
export interface KnownBucket {
  readonly accountId: string;
  readonly bucket: string;
  readonly jurisdiction: R2Jurisdiction;
}

/** One bucket in the signed-in account, as the panel lists them. */
export interface CloudflareBucketRef {
  readonly name: string;
  readonly jurisdiction: R2Jurisdiction;
}

export interface CloudflareConnectionOptions {
  readonly paths: PlatformPaths;
  readonly client: OAuthClientSettings;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Everything about a bucket connected by signing in to Cloudflare.
 *
 * It keeps the OAuth identity apart from the way data travels: the grant and
 * the account belong here, and what the backup code sees is an object store
 * that goes through the Worker when it can and the REST API when it cannot.
 * Manual S3 keys do not come through here at all.
 */
export class CloudflareConnection {
  private readonly paths: PlatformPaths;
  private readonly client: OAuthClientSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly api: CloudflareApi;
  private readonly worker: BackupWorker;
  private readonly pacer = new RequestPacer();
  private stored: StoredConnection | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private pending: PendingSignIn[] = [];
  private offeredAccounts: CloudflareAccount[] = [];
  private accessToken: { value: string; expiresAt: number | null } | null = null;
  private refreshing: Promise<string> | null = null;
  private session: WorkerSession | null = null;
  private opening: Promise<WorkerSession> | null = null;
  private nextRotationAttempt = 0;
  private workerUnavailableUntil = 0;
  private lastPath: CloudflareDataPath | null = null;

  public constructor(options: CloudflareConnectionOptions) {
    this.paths = options.paths;
    this.client = options.client;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.api = new CloudflareApi({ accessToken: async () => await this.token(), fetchImpl: this.fetchImpl, now: this.now });
    this.worker = new BackupWorker({ api: this.api, fetchImpl: this.fetchImpl, now: this.now, sleep: this.sleep });
  }

  public async status(): Promise<CloudflareConnectionStatus> {
    const stored = await this.load();
    const state: CloudflareConnectionState = stored.reconnectRequired
      ? 'reconnect_required'
      : !stored.refreshToken ? 'disconnected'
        : !stored.account || !stored.bucket ? 'choose_account'
          : 'connected';
    return {
      state,
      account: stored.account,
      bucket: stored.bucket?.name ?? null,
      accounts: state === 'choose_account' ? this.offeredAccounts : [],
      dataPath: state === 'connected' ? this.lastPath : null,
      restReason: state !== 'connected' ? null
        : !stored.scopes.includes(DEFAULT_SCOPES.workersScriptsWrite) ? 'workers_not_granted'
          : this.lastPath === 'rest' ? 'worker_unavailable' : null,
      analyticsGranted: stored.scopes.includes(DEFAULT_SCOPES.analyticsRead),
      connectedAt: stored.connectedAt,
      lastError: stored.lastError,
      problem: stored.problem,
      displacedBy: stored.displacedBy,
    };
  }

  /** Whether backups can go through this connection right now. */
  public async usable(): Promise<boolean> {
    return (await this.status()).state === 'connected';
  }

  /**
   * Start a sign-in with Cloudflare, and say what it is for.
   *
   * `connect` is somebody who is already in the console arranging where their
   * backups go. `signIn` is somebody opening the console with their Cloudflare
   * account instead of a password, which is a sign-in that has to be allowed
   * to finish without a session - because not having one is the point.
   *
   * The purpose is held here rather than in the state Cloudflare hands back,
   * so nothing a browser can edit decides whether a session is required. The
   * cost is that it does not survive a restart of the manager, which is
   * already true of the authorization it belongs to.
   *
   * A `connect` is also told which console session asked for it, because the
   * browser that comes back from Cloudflare is not always the one that left.
   * Cloudflare will not load in a frame, so a framed console sends the reader
   * out to a window of its own - and a window of its own is a different place
   * for cookies than a frame is, so the callback can arrive carrying no
   * session at all while the console that started it is still signed in two
   * inches away. Remembering the session here settles it in this process,
   * rather than asking the returning browser to prove something it cannot.
   *
   * Several can be in flight together; see `PENDING_SIGN_IN_LIMIT`.
   */
  public beginConnect(returnOrigin: string, purpose: CloudflarePurpose = 'connect', startedBy?: string): string {
    const authorization = createAuthorization(this.client, returnOrigin, this.now());
    // Expired ones first, so the room is spent on sign-ins that can still finish.
    this.prunePending().push({ authorization, purpose, ...(startedBy ? { startedBy } : {}) });
    while (this.pending.length > PENDING_SIGN_IN_LIMIT) this.pending.shift();
    return authorization.url;
  }

  /** What the sign-in this callback belongs to was started for, if it is one of ours. */
  public pendingPurpose(state: string): CloudflarePurpose | null {
    return this.findPending(state)?.purpose ?? null;
  }

  /** The console session that started this sign-in, if one did and it is still ours. */
  public pendingStartedBy(state: string): string | null {
    return this.findPending(state)?.startedBy ?? null;
  }

  private findPending(state: string): PendingSignIn | undefined {
    return this.prunePending().find((entry) => matchesPending(entry.authorization, state, this.now()));
  }

  /** Drop the sign-ins that have run out of time, and return what is left. */
  private prunePending(): PendingSignIn[] {
    const now = this.now();
    this.pending = this.pending.filter((entry) => now - entry.authorization.createdAt <= AUTHORIZATION_TTL_MS);
    return this.pending;
  }

  /**
   * The sign-in this callback belongs to, spent.
   *
   * Taken out of the list whether or not what follows succeeds: a state is
   * good once, and a code that was refused must not be answerable again.
   */
  private takePending(state: string): PendingSignIn | null {
    const index = this.prunePending().findIndex((entry) => matchesPending(entry.authorization, state, this.now()));
    if (index === -1) return null;
    return this.pending.splice(index, 1)[0] ?? null;
  }

  /**
   * Finish signing in with what Cloudflare sent back to the callback.
   *
   * The refresh token is on disk before anything else is asked of Cloudflare,
   * so a failure later in setup never loses the grant the user just gave.
   */
  public async completeConnect(callback: { state: string; code?: string | null; error?: string | null; errorDescription?: string | null }, known: KnownBucket | null = null): Promise<CloudflareConnectionStatus> {
    const entry = this.takePending(callback.state);
    if (!entry) throw new R2Error('cloudflare_state_mismatch', 'This sign-in link has expired or was not started here. Connect again.');
    const pending = entry.authorization;
    if (callback.error) {
      const reason = callback.error === 'access_denied' ? 'Access was not granted on Cloudflare.' : `Cloudflare refused the sign-in: ${callback.errorDescription ?? callback.error}`;
      throw new R2Error('cloudflare_authorization_denied', reason);
    }
    const grant = await exchangeCode(this.client, pending, callback.code ?? '', { fetchImpl: this.fetchImpl, now: this.now });
    if (!grant.refreshToken) throw new R2Error('cloudflare_no_refresh_token', 'Cloudflare did not issue a refresh token, so the connection could not outlive this hour.');
    const previous = await this.load();
    this.resetSession();
    this.accessToken = { value: grant.accessToken, expiresAt: grant.expiresAt };
    await this.save({
      ...previous,
      refreshToken: grant.refreshToken,
      scopes: grant.scopes,
      reconnectRequired: false,
      lastError: null,
      connectedAt: new Date(this.now()).toISOString(),
      // Whatever took the account before, this sign-in is the newest one, so
      // it is this machine's again and the note about losing it is not true.
      displacedBy: null,
      // A reconnect to the same account keeps its bucket; anything else is chosen again below.
      account: previous.account,
      bucket: previous.bucket,
    });
    const accounts = await this.api.listAccounts();
    this.offeredAccounts = accounts;
    const kept = previous.account ? accounts.find((account) => account.id === previous.account?.id) : undefined;
    const only = accounts.length === 1 ? accounts[0] : undefined;
    const chosen = kept ?? only;
    if (chosen) return await this.chooseAccount(chosen.id, known);
    await this.save({ ...(await this.load()), account: null, bucket: null });
    if (accounts.length === 0) throw new R2Error('cloudflare_no_account', 'The grant does not reach any Cloudflare account. Connect again and select an account.');
    return await this.status();
  }

  /**
   * Use this account, and the bucket backups already go to when it is in this
   * account; otherwise the manager's own bucket, created if it is not there.
   */
  public async chooseAccount(accountId: string, known: KnownBucket | null = null): Promise<CloudflareConnectionStatus> {
    const stored = await this.load();
    if (!stored.refreshToken) throw new R2Error('cloudflare_not_connected', 'Connect to Cloudflare first');
    if (this.offeredAccounts.length === 0) this.offeredAccounts = await this.api.listAccounts();
    const account = this.offeredAccounts.find((entry) => entry.id === accountId);
    if (!account) throw new R2Error('cloudflare_unknown_account', 'That account is not one this sign-in can reach');
    let bucket;
    try {
      const existing = known?.accountId === account.id ? await this.api.findBucket(account.id, known.bucket, { jurisdiction: known.jurisdiction }) : null;
      bucket = existing ?? (await this.api.ensureBackupBucket(account.id)).bucket;
    } catch (error: unknown) {
      /*
       * The account has never turned R2 on.
       *
       * The sign-in worked and every permission asked for was granted; there
       * is simply no R2 on this account to put a bucket in. Recorded on the
       * connection rather than thrown away with the request, so the panel can
       * keep saying what is wrong and where to fix it after the refusal that
       * carried it has scrolled past. The account is kept for the same reason:
       * the reader is coming back to this page after enabling R2, and it should
       * know which account they chose.
       */
      if (isR2NotEnabled(error)) {
        await this.save({ ...(await this.load()), account, bucket: null, problem: 'r2_not_enabled', lastError: 'R2 is not enabled on this Cloudflare account yet.' });
        throw new R2Error('cloudflare_r2_not_enabled', 'This Cloudflare account has not enabled R2 yet. Turn it on in the Cloudflare dashboard, then connect again.');
      }
      throw error;
    }
    if (stored.account?.id !== account.id || stored.bucket?.name !== bucket.name || stored.bucket.jurisdiction !== bucket.jurisdiction) this.resetSession();
    await this.save({ ...(await this.load()), account, bucket: { name: bucket.name, jurisdiction: bucket.jurisdiction }, lastError: null, problem: null });
    this.offeredAccounts = [];
    return await this.status();
  }

  /** Every R2 bucket in the signed-in account, for choosing which one to back up to. */
  public async listBuckets(): Promise<CloudflareBucketRef[]> {
    const stored = await this.requireConnected();
    const buckets = await this.api.listBuckets(stored.account.id);
    return buckets.map((bucket) => ({ name: bucket.name, jurisdiction: bucket.jurisdiction }));
  }

  /**
   * Back up to this bucket instead of the one chosen when the account was.
   *
   * Only a bucket the account already has: creating one is what connecting
   * does, and a typo here would otherwise make an empty bucket nobody wanted.
   * The Worker is bound to a bucket when it is deployed, so the session is
   * dropped and the next request redeploys it against the new one.
   */
  public async chooseBucket(name: string): Promise<CloudflareConnectionStatus> {
    const stored = await this.requireConnected();
    if (stored.bucket.name === name) return await this.status();
    const bucket = await this.api.findBucket(stored.account.id, name);
    if (!bucket) throw new R2Error('cloudflare_unknown_bucket', `This Cloudflare account has no bucket named ${name}`);
    this.resetSession();
    await this.save({ ...(await this.load()), bucket: { name: bucket.name, jurisdiction: bucket.jurisdiction }, lastError: null });
    return await this.status();
  }

  /**
   * Sign out: this installation's Worker key goes, then the grant is revoked.
   *
   * The local grant is forgotten whatever Cloudflare answers, because the user
   * asked for it to be gone. A revocation that failed is still reported, since
   * the grant may then live on until the user revokes it in the dashboard.
   */
  public async disconnect(): Promise<{ revoked: boolean; workerKeyRemoved: boolean; workerRemoved: boolean }> {
    const stored = await this.load();
    let workerKeyRemoved = false;
    let workerRemoved = false;
    let revoked = false;
    if (stored.refreshToken) {
      if (stored.account && stored.scopes.includes(DEFAULT_SCOPES.workersScriptsWrite)) {
        workerKeyRemoved = await this.worker.removeKey(stored.account.id, stored.installationKeyId).then(() => true, () => false);
        /*
         * And the Worker itself, once nothing else holds a key on it.
         *
         * Removing only this installation's key left the script deployed, on
         * the account's own subdomain, bound to the bucket, for a reader who
         * had just asked for the connection to be gone. Another machine
         * backing up to the same account is the one reason to leave it, and
         * its key is how it says so.
         */
        workerRemoved = await this.worker.keyIds(stored.account.id)
          .then(async (keyIds) => keyIds.length === 0 && await this.worker.remove(stored.account?.id ?? ''))
          .catch(() => false);
      }
      revoked = await revokeToken(this.client.clientId, stored.refreshToken, { fetchImpl: this.fetchImpl }).then(() => true, () => false);
    }
    this.resetSession();
    this.accessToken = null;
    this.pending = [];
    this.offeredAccounts = [];
    await this.save({ ...stored, refreshToken: null, scopes: [], account: null, bucket: null, connectedAt: null, reconnectRequired: false, lastError: null, problem: null, displacedBy: null });
    return { revoked, workerKeyRemoved, workerRemoved };
  }

  /** This installation, as the bucket's claim names it. Stable across reconnects. */
  public async installationId(): Promise<string> {
    return (await this.load()).installationKeyId;
  }

  /**
   * Stop another installation from reaching the bucket through the Worker.
   *
   * The claim in the bucket is what one manager reads to know it is not the
   * one using this account, and a manager that respects it stops on its own.
   * This is the other half: the key it signs with is taken off the Worker, so
   * a machine that is not listening - an older version, one mid-run - stops
   * too, at the first request rather than at the next check.
   */
  public async evict(keyId: string): Promise<boolean> {
    const stored = await this.load();
    if (!stored.account || !stored.scopes.includes(DEFAULT_SCOPES.workersScriptsWrite)) return false;
    if (keyId === stored.installationKeyId) return false;
    return await this.worker.removeKey(stored.account.id, keyId).then(() => true, () => false);
  }

  /**
   * Give the account up, because another machine holds it now.
   *
   * The claim in the bucket says who is using this Cloudflare account, and a
   * manager that reads somebody else's name in it has already lost. Until now
   * that only stopped the backups: the grant stayed on disk and went on
   * working, so this manager could still deploy Workers into the account,
   * read and write objects over the REST API, and ask Cloudflare what the
   * account had spent - all of it against an account that is not its to touch
   * any more. The console said as much, in the one sentence it had for a
   * Worker that would not answer: backups are going the slower way for now.
   *
   * So the credentials go, here, on the machine that lost. Nothing is left to
   * reach the account with: no refresh token, no access token, no Worker
   * session. What stays is the account and bucket it was using, because they
   * are how a sign-in from here lands back on the same bucket rather than
   * making a second one - and the name of the machine that took it, because
   * that is the whole of what the reader needs to be told.
   *
   * This is deliberately local. Cloudflare's own revocation endpoint is not
   * called: the grant this manager would revoke is one Cloudflare issued to
   * this client for this user, and the machine that has just taken the account
   * holds one issued the same way. Revoking from here to be thorough risks
   * ending theirs too - on a machine nobody is watching, to tidy up a token
   * that has already been thrown away. Signing out by hand still revokes,
   * because that is somebody asking for it on the machine in front of them.
   *
   * Returns whether anything was given up, so a caller can say so once rather
   * than on every check.
   */
  public async surrender(by: string, reason: string): Promise<boolean> {
    const stored = await this.load();
    if (!stored.refreshToken) return false;
    this.resetSession();
    this.accessToken = null;
    this.refreshing = null;
    this.pending = [];
    this.offeredAccounts = [];
    await this.save({
      ...stored,
      refreshToken: null,
      scopes: [],
      reconnectRequired: true,
      problem: null,
      lastError: reason.slice(0, 500),
      displacedBy: by.slice(0, 120),
    });
    return true;
  }

  /**
   * The bucket as an object store, for the backup code.
   *
   * Which way each request travels is decided when it is made, so a rotation,
   * a fallback to REST, or the Worker coming back needs nothing from the caller.
   */
  public objectStore(onRequest: (billing: Billing) => void): ObjectStore {
    const workerStore = new WorkerObjectStore({ session: async () => await this.workerSession(), onRequest, fetchImpl: this.fetchImpl, now: this.now, sleep: this.sleep });
    const restStore = async (): Promise<RestObjectStore> => {
      const { account, bucket } = await this.requireConnected();
      return new RestObjectStore({ accountId: account.id, bucket: bucket.name, jurisdiction: bucket.jurisdiction, accessToken: async () => await this.token(), onRequest, fetchImpl: this.fetchImpl, pacer: this.pacer });
    };
    const route = async <T>(operation: (store: ObjectStore) => Promise<T>): Promise<T> => {
      const path = await this.choosePath();
      this.lastPath = path;
      if (path !== 'worker') return await operation(await restStore());
      try {
        return await operation(workerStore);
      } catch (error: unknown) {
        /*
         * The Worker does not know this key any more.
         *
         * Which happens for one reason in practice: another manager signed in
         * with this Cloudflare account and took it, and taking it removes the
         * other machine's key. The refusal itself says none of that - it is a
         * flat `401 unauthorized`, which is what the console used to show and
         * what nobody could act on.
         *
         * The fact is in the bucket, in the claim, and reading the claim needs
         * a way in. The OAuth grant still works - eviction only removed a
         * Worker key - so the data goes the slow way for a while, this request
         * finishes, and the next check reads the claim and can finally say who
         * took the account and what to do about it.
         */
        if (!(error instanceof R2HttpError) || error.status !== 401) throw error;
        this.session = null;
        this.opening = null;
        this.workerUnavailableUntil = this.now() + WORKER_RETRY_MS;
        this.lastPath = 'rest';
        await this.recordError('The backup Worker no longer accepts this machine’s key, so backups go over the slower REST API while this is sorted out.');
        return await operation(await restStore());
      }
    };
    return {
      listObjects: async (prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: ObjectRecord[]; cursor: string | undefined }> => await route((store) => store.listObjects(prefix, maxKeys, cursor)),
      putObject: async (key: string, body: Uint8Array, contentType: string): Promise<void> => await route((store) => store.putObject(key, body, contentType)),
      getObject: async (key: string): Promise<Buffer> => await route((store) => store.getObject(key)),
      deleteObject: async (key: string): Promise<void> => await route((store) => store.deleteObject(key)),
    };
  }

  /** The account and bucket, for showing and for the analytics queries. */
  public async target(): Promise<{ account: CloudflareAccount; bucket: string; jurisdiction: R2Jurisdiction } | null> {
    const stored = await this.load();
    return stored.refreshToken && stored.account && stored.bucket && !stored.reconnectRequired ? { account: stored.account, bucket: stored.bucket.name, jurisdiction: stored.bucket.jurisdiction } : null;
  }

  /** The API client on this grant, for callers that need more than objects (metrics). */
  public cloudflareApi(): CloudflareApi {
    return this.api;
  }

  /**
   * The signed-in account, for work that needs Workers but not the bucket.
   *
   * The Worker that gives a tunnel a fixed address is one of those: it has
   * nothing to do with backups, needs no bucket, and is possible exactly when
   * there is an account and the grant included permission to deploy scripts.
   * Null covers every reason it is not - not signed in, signed out again, the
   * grant expired, or that permission declined on the consent screen - because
   * the caller does the same thing in all of them: nothing.
   */
  public async workersAccount(): Promise<CloudflareAccount | null> {
    const stored = await this.load();
    if (!stored.refreshToken || !stored.account || stored.reconnectRequired) return null;
    if (!stored.scopes.includes(DEFAULT_SCOPES.workersScriptsWrite)) return null;
    return stored.account;
  }

  private async choosePath(): Promise<CloudflareDataPath> {
    const stored = await this.requireConnected();
    if (!stored.scopes.includes(DEFAULT_SCOPES.workersScriptsWrite)) return 'rest';
    if (this.now() < this.workerUnavailableUntil) return 'rest';
    try {
      await this.workerSession();
      // The Worker carries the data again, so a note about it not doing so is
      // no longer true. Written only when there is one, since this runs per request.
      if (stored.lastError !== null) await this.save({ ...(await this.load()), lastError: null });
      return 'worker';
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError && (error.code === 'worker_unreachable' || error.code === 'worker_not_ready' || error.status === 403)) {
        // workers.dev blocked on this network, or the Worker could not be set up.
        // The data still has a way to go; the Worker is tried again later.
        this.workerUnavailableUntil = this.now() + WORKER_RETRY_MS;
        await this.recordError(`The backup Worker could not be used, so backups go over the slower REST API for now: ${error.message}`);
        return 'rest';
      }
      throw error;
    }
  }

  /**
   * The Worker session to sign with, opened on first use and rotated once a day.
   *
   * A rotation that fails keeps the current key in use until it expires, so a
   * short Cloudflare outage at rotation time does not stop backups.
   */
  private async workerSession(): Promise<WorkerSession> {
    const now = this.now();
    const current = this.session;
    if (current && now < current.rotateAt) return current;
    if (current && now < current.expiresAt && now < this.nextRotationAttempt) return current;
    if (!this.opening) {
      this.opening = (async () => {
        const { account, bucket, installationKeyId } = await this.requireConnected();
        try {
          const opened = await this.worker.open(account.id, bucket.name, installationKeyId);
          this.session = opened;
          return opened;
        } catch (error: unknown) {
          const fallback = this.session;
          if (fallback && this.now() < fallback.expiresAt) {
            this.nextRotationAttempt = this.now() + ROTATION_RETRY_MS;
            return fallback;
          }
          throw error;
        }
      })().finally(() => { this.opening = null; });
    }
    return await this.opening;
  }

  /**
   * An access token that is good for at least another minute.
   *
   * Refreshes are single-flight: two requests finding the token expired share one
   * refresh, because Cloudflare rotates the refresh token and a second refresh
   * with the old one would be refused.
   */
  private async token(): Promise<string> {
    const current = this.accessToken;
    if (current && (current.expiresAt === null || this.now() < current.expiresAt - ACCESS_TOKEN_MARGIN_MS)) return current.value;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const stored = await this.load();
        if (!stored.refreshToken || stored.reconnectRequired) throw new R2Error('cloudflare_reconnect_required', 'Reconnect to Cloudflare to continue backing up');
        try {
          const grant = await refreshGrant(this.client, stored.refreshToken, { fetchImpl: this.fetchImpl, now: this.now });
          // On disk first. If the manager stops between here and the next line,
          // the token Cloudflare now expects is the one that survives.
          await this.save({ ...(await this.load()), refreshToken: grant.refreshToken ?? stored.refreshToken, scopes: grant.scopes.length > 0 ? grant.scopes : stored.scopes });
          this.accessToken = { value: grant.accessToken, expiresAt: grant.expiresAt };
          return grant.accessToken;
        } catch (error: unknown) {
          if (error instanceof CloudflareOAuthError && error.code === 'oauth_grant_revoked') {
            this.resetSession();
            await this.save({ ...(await this.load()), reconnectRequired: true, lastError: 'Cloudflare no longer accepts this sign-in. It was revoked or expired; connect again.' });
            throw new R2Error('cloudflare_reconnect_required', 'Cloudflare no longer accepts this sign-in. Reconnect to continue backing up.');
          }
          throw error;
        }
      })().finally(() => { this.refreshing = null; });
    }
    return await this.refreshing;
  }

  private async requireConnected(): Promise<StoredConnection & { account: CloudflareAccount; bucket: { name: string; jurisdiction: R2Jurisdiction } }> {
    const stored = await this.load();
    if (stored.reconnectRequired) throw new R2Error('cloudflare_reconnect_required', 'Reconnect to Cloudflare to continue backing up');
    if (!stored.refreshToken || !stored.account || !stored.bucket) throw new R2Error('r2_not_configured', 'Connect to Cloudflare and choose an account first');
    return stored as StoredConnection & { account: CloudflareAccount; bucket: { name: string; jurisdiction: R2Jurisdiction } };
  }

  private resetSession(): void {
    this.session = null;
    this.opening = null;
    this.nextRotationAttempt = 0;
    this.workerUnavailableUntil = 0;
    this.lastPath = null;
  }

  private async recordError(message: string): Promise<void> {
    await this.save({ ...(await this.load()), lastError: message.slice(0, 500) });
  }

  private async load(): Promise<StoredConnection> {
    if (this.stored) return this.stored;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, CONNECTION_FILE), 'utf8'));
      this.stored = parseStored(parsed);
    } catch (error: unknown) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      const fresh: StoredConnection = {
        schemaVersion: SCHEMA_VERSION,
        installationKeyId: randomBytes(8).toString('hex'),
        refreshToken: null,
        scopes: [],
        account: null,
        bucket: null,
        connectedAt: null,
        reconnectRequired: false,
        lastError: null,
        problem: null,
        displacedBy: null,
      };
      await this.save(fresh);
    }
    if (!this.stored) throw new Error('Cloudflare connection state could not be loaded');
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
    throw new Error('Unsupported Cloudflare connection state');
  }
  const account = isRecord(value.account) && typeof value.account.id === 'string' && typeof value.account.name === 'string' ? { id: value.account.id, name: value.account.name } : null;
  const bucket = isRecord(value.bucket) && typeof value.bucket.name === 'string' ? { name: value.bucket.name, jurisdiction: (typeof value.bucket.jurisdiction === 'string' ? value.bucket.jurisdiction : 'default') as R2Jurisdiction } : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    installationKeyId: value.installationKeyId,
    refreshToken: typeof value.refreshToken === 'string' && value.refreshToken ? value.refreshToken : null,
    scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    account,
    bucket,
    connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : null,
    reconnectRequired: value.reconnectRequired === true,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    problem: value.problem === 'r2_not_enabled' ? 'r2_not_enabled' : null,
    displacedBy: typeof value.displacedBy === 'string' && value.displacedBy ? value.displacedBy : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
