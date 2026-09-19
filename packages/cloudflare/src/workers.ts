import { createHmac, randomBytes } from 'node:crypto';
import { CloudflareApi, CloudflareApiError, segment } from './api.js';
import { WORKER_COMPATIBILITY_DATE, WORKER_SCRIPT_NAME, WORKER_SOURCE, WORKER_VERSION } from './worker-script.js';

/**
 * How long one key is good for.
 *
 * The manager rotates at a day. Rotating replaces the secret, and the old key is
 * refused from that moment (measured live), so the extra hour is not an overlap
 * for runs in progress - the store re-signs those with the new key. It is room
 * for a manager that could not reach Cloudflare when rotation was due.
 */
export const WORKER_KEY_TTL_MS = 25 * 60 * 60 * 1000;
export const WORKER_ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * How long a new key or deployment takes to reach every edge that may answer.
 *
 * Measured live on a first deploy: after one check passed, half of 30 parallel
 * requests were still refused a second later, 3 of 30 at five seconds, none at
 * nine. Requests one after another tend to reach the same edge, so each check
 * is a burst in parallel, and only bursts that all pass, several in a row, count.
 * Rotating a key or redeploying an existing script showed no refusals at all.
 */
const READY_ATTEMPTS = 40;
/**
 * Replacing a script takes longer to reach every edge than adding a secret to
 * one, and until it has, edges answer with the version before it. Measured on a
 * live account, a replacement that changed the bucket binding was still mixed
 * at forty seconds, so waiting for a named deployment gets more patience than
 * waiting to see what is there.
 */
const READY_ATTEMPTS_AFTER_DEPLOY = 120;
const READY_DELAY_MS = 1_000;
const READY_BURST = 8;
const READY_STREAK = 3;
/**
 * For this long after a key is issued, a refusal may be an edge that has not
 * caught up rather than a wrong key, and the request is tried again.
 */
export const WORKER_KEY_SETTLE_MS = 2 * 60 * 1000;

/** What a deployed Worker says it is: its code version and the bucket it is bound to. */
interface WorkerDeployment {
  readonly version: number;
  readonly bucket: string | null;
}

/** Everything needed to send one request to the Worker. The key lives only in memory. */
export interface WorkerSession {
  readonly baseUrl: string;
  readonly keyId: string;
  readonly key: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly rotateAt: number;
}

export interface BackupWorkerOptions {
  readonly api: CloudflareApi;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Deploys, keys and checks the backup Worker in one account.
 *
 * Every call to `open` issues a new key for this installation, so a restart or a
 * rotation needs no key from before - which is why no key is ever written to
 * disk. A deploy keeps the other installations' secrets, so opening a session on
 * one machine does not end another's.
 */
export class BackupWorker {
  private readonly api: CloudflareApi;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(options: BackupWorkerOptions) {
    this.api = options.api;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public async open(accountId: string, bucket: string, keyId: string): Promise<WorkerSession> {
    if (!/^[a-z0-9]{8,64}$/u.test(keyId)) throw new CloudflareApiError('worker_invalid_key_id', 400, 'The Worker key ID is not valid');
    const subdomain = await this.subdomain(accountId);
    const key = randomBytes(32).toString('base64url');
    const issuedAt = this.now();
    const expiresAt = issuedAt + WORKER_KEY_TTL_MS;
    const secret = { name: secretName(keyId), text: `${expiresAt}.${key}` };
    try {
      await this.putKey(accountId, secret);
    } catch (error: unknown) {
      // No script yet. The key goes up with it, in the same deployment: a
      // deploy followed by a separate secret is two versions, and edges still
      // serving the first one refuse the key.
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
      await this.deploy(accountId, bucket, secret);
    }
    const session: WorkerSession = { baseUrl: `https://${WORKER_SCRIPT_NAME}.${subdomain}.workers.dev`, keyId, key, issuedAt, expiresAt, rotateAt: issuedAt + WORKER_ROTATE_AFTER_MS };
    const deployed = await this.waitForDeployment(session);
    // One script per account, bound to one bucket when it was deployed. Only
    // the current code bound to this bucket may carry this bucket's data.
    if (deployed?.version !== WORKER_VERSION || deployed.bucket !== bucket) {
      await this.deploy(accountId, bucket, secret);
      const replaced = await this.waitForDeployment(session, { version: WORKER_VERSION, bucket });
      if (replaced?.version !== WORKER_VERSION || replaced.bucket !== bucket) throw new CloudflareApiError('worker_not_ready', 503, 'The backup Worker did not come up after it was deployed');
    }
    return session;
  }

  private async checkVersion(session: WorkerSession): Promise<{ ok: boolean; status: number; deployment: WorkerDeployment | null }> {
    try {
      const response = await this.fetchImpl(`${session.baseUrl}/v1/version`, { headers: signWorkerRequest(session, 'GET', '/v1/version', this.now()) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, status: response.status, deployment: null };
      }
      const parsed: unknown = await response.json().catch(() => null);
      const deployment = isRecord(parsed) && typeof parsed.version === 'number' ? { version: parsed.version, bucket: typeof parsed.bucket === 'string' ? parsed.bucket : null } : null;
      return { ok: true, status: response.status, deployment };
    } catch {
      // Not reachable yet, or workers.dev is blocked where the manager runs.
      return { ok: false, status: 0, deployment: null };
    }
  }

  /** Remove one installation's key: its own on Disconnect, another's on a takeover. */
  public async removeKey(accountId: string, keyId: string): Promise<void> {
    try {
      await this.api.call('DELETE', `/accounts/${segment(accountId)}/workers/scripts/${WORKER_SCRIPT_NAME}/secrets/${secretName(keyId)}`);
    } catch (error: unknown) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
  }

  /**
   * The installations that still hold a key on this Worker.
   *
   * Secret values cannot be read back, but their names can be listed, and each
   * key is named after the installation that asked for it. That is enough to
   * answer the only question Disconnect has: is anything else still using this.
   */
  public async keyIds(accountId: string): Promise<string[]> {
    let result;
    try {
      ({ result } = await this.api.call('GET', `/accounts/${segment(accountId)}/workers/scripts/${WORKER_SCRIPT_NAME}/secrets`));
    } catch (error: unknown) {
      // No Worker, so no keys on it.
      if (error instanceof CloudflareApiError && error.status === 404) return [];
      throw error;
    }
    const entries = Array.isArray(result) ? result : [];
    return entries
      .map((entry) => isRecord(entry) && typeof entry.name === 'string' ? entry.name : '')
      .filter((name) => name.startsWith(KEY_SECRET_PREFIX))
      .map((name) => name.slice(KEY_SECRET_PREFIX.length));
  }

  /**
   * Take the Worker out of the account altogether.
   *
   * Signing out has to leave nothing behind: a Worker nobody can explain,
   * still answering on the account's own subdomain and still bound to a
   * bucket, is the worst thing for an account owner to find. Done only when no
   * other installation holds a key on it - the account may be one somebody
   * else's machine is also backing up to.
   */
  public async remove(accountId: string): Promise<boolean> {
    try {
      await this.api.call('DELETE', `/accounts/${segment(accountId)}/workers/scripts/${WORKER_SCRIPT_NAME}`);
      return true;
    } catch (error: unknown) {
      // Already gone is the outcome that was wanted.
      if (error instanceof CloudflareApiError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * The account's `workers.dev` subdomain, claimed if the account never had one.
   *
   * The name is the account's, visible in the dashboard and in every Worker URL,
   * so an existing one is always used as it is.
   */
  private async subdomain(accountId: string): Promise<string> {
    try {
      const { result } = await this.api.call('GET', `/accounts/${segment(accountId)}/workers/subdomain`);
      if (isRecord(result) && typeof result.subdomain === 'string' && result.subdomain) return result.subdomain;
    } catch (error: unknown) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    const { result } = await this.api.call('PUT', `/accounts/${segment(accountId)}/workers/subdomain`, { body: { subdomain: `stm-${accountId.slice(0, 12)}` } });
    if (isRecord(result) && typeof result.subdomain === 'string' && result.subdomain) return result.subdomain;
    throw new CloudflareApiError('worker_no_subdomain', 502, 'Cloudflare did not return a workers.dev subdomain');
  }

  private async deploy(accountId: string, bucket: string, secret: { name: string; text: string }): Promise<void> {
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({
      main_module: 'worker.js',
      compatibility_date: WORKER_COMPATIBILITY_DATE,
      bindings: [{ type: 'r2_bucket', name: 'BUCKET', bucket_name: bucket }, { type: 'plain_text', name: 'BUCKET_NAME', text: bucket }, { type: 'secret_text', ...secret }],
      // Every other installation's key is a secret on this script too.
      // Replacing the code must not take them with it.
      keep_bindings: ['secret_text'],
    })], { type: 'application/json' }));
    form.set('worker.js', new Blob([WORKER_SOURCE], { type: 'application/javascript+module' }), 'worker.js');
    await this.api.call('PUT', `/accounts/${segment(accountId)}/workers/scripts/${WORKER_SCRIPT_NAME}`, { form });
    await this.api.call('POST', `/accounts/${segment(accountId)}/workers/scripts/${WORKER_SCRIPT_NAME}/subdomain`, { body: { enabled: true, previews_enabled: false } });
  }

  private async putKey(accountId: string, secret: { name: string; text: string }): Promise<void> {
    await this.api.call('PUT', `/accounts/${segment(accountId)}/workers/scripts/${WORKER_SCRIPT_NAME}/secrets`, { body: { ...secret, type: 'secret_text' } });
  }

  /**
   * The version and bucket the Worker reports once it reliably accepts the new key, or null.
   *
   * A secret or a deployment takes seconds to reach every edge; until then some
   * requests still land on the previous version and are refused. Only a run of
   * successes in a row counts as ready.
   */
  private async waitForDeployment(session: WorkerSession, wanted?: WorkerDeployment): Promise<WorkerDeployment | null> {
    let seen: WorkerDeployment | null = null;
    let streak = 0;
    const same = (left: WorkerDeployment | null, right: WorkerDeployment | null): boolean => left?.version === right?.version && left?.bucket === right?.bucket;
    const attempts = wanted === undefined ? READY_ATTEMPTS : READY_ATTEMPTS_AFTER_DEPLOY;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const answers = await Promise.all(Array.from({ length: READY_BURST }, async () => await this.checkVersion(session)));
      const [first] = answers;
      if (first?.deployment && answers.every((answer) => answer.ok && same(answer.deployment, first.deployment))) {
        streak = same(first.deployment, seen) ? streak + 1 : 1;
        seen = first.deployment;
        if ((wanted === undefined || same(seen, wanted)) && streak >= READY_STREAK) return seen;
      } else {
        streak = 0;
        // The route answers everywhere but the script has no version endpoint: an older deploy.
        if (wanted === undefined && answers.every((answer) => answer.status === 404)) return null;
      }
      await this.sleep(READY_DELAY_MS);
    }
    if (seen !== null && wanted === undefined) return seen;
    if (seen === null && wanted === undefined) throw new CloudflareApiError('worker_unreachable', 503, 'The backup Worker could not be reached on workers.dev');
    return seen;
  }
}

/** The headers that prove a request comes from the installation holding the key. */
export function signWorkerRequest(session: Pick<WorkerSession, 'keyId' | 'key'>, method: string, pathAndQuery: string, now: number): Record<string, string> {
  const timestamp = String(now);
  const signature = createHmac('sha256', session.key).update(`${method}\n${pathAndQuery}\n${timestamp}`, 'utf8').digest('hex');
  return { 'x-stm-key-id': session.keyId, 'x-stm-timestamp': timestamp, 'x-stm-signature': signature };
}

const KEY_SECRET_PREFIX = 'STM_KEY_';

function secretName(keyId: string): string {
  return `${KEY_SECRET_PREFIX}${keyId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
