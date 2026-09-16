import { signWorkerRequest, WORKER_KEY_SETTLE_MS, type WorkerSession } from '../../cloudflare/src/index.js';
import { R2HttpError, type Billing, type ObjectRecord, type ObjectStore } from './store.js';

export interface WorkerObjectStoreOptions {
  /**
   * The session to sign with, asked for on every request.
   *
   * Rotation happens behind it: whoever owns the session opens a new one when
   * the old one is due, and the next request simply signs with that.
   */
  readonly session: () => Promise<WorkerSession>;
  readonly onRequest: (billing: Billing) => void;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Waits before trying a refused request again while a new key is still reaching the edge. */
const SETTLE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/**
 * The bucket through the backup Worker in the user's account.
 *
 * The fast way in when the bucket was connected with OAuth: requests go to the
 * Worker's `workers.dev` address, not to the API, so they do not count against
 * the user's API rate limit. The operations are billed the same as over S3.
 */
export class WorkerObjectStore implements ObjectStore {
  private readonly options: WorkerObjectStoreOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(options: WorkerObjectStoreOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public async listObjects(prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: ObjectRecord[]; cursor: string | undefined }> {
    const query = new URLSearchParams([['prefix', prefix], ['limit', String(Math.min(Math.max(maxKeys, 1), 1000))]]);
    if (cursor) query.set('cursor', cursor);
    const response = await this.request('GET', `/v1/list?${query.toString()}`, undefined, {}, 'charged');
    const parsed: unknown = await response.json().catch(() => null);
    if (!isRecord(parsed) || !Array.isArray(parsed.objects)) throw new R2HttpError(response.status, 'The backup Worker returned an unreadable listing');
    const objects: ObjectRecord[] = [];
    for (const entry of parsed.objects) {
      if (!isRecord(entry) || typeof entry.key !== 'string' || !entry.key) continue;
      const size = Number(entry.size ?? 0);
      objects.push({
        key: entry.key,
        sizeBytes: Number.isFinite(size) ? size : 0,
        lastModified: typeof entry.uploaded === 'string' ? entry.uploaded : null,
        etag: typeof entry.etag === 'string' ? entry.etag : null,
      });
    }
    return { objects, cursor: typeof parsed.cursor === 'string' && parsed.cursor ? parsed.cursor : undefined };
  }

  public async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.request('PUT', objectPath(key), body, { 'content-type': contentType, 'content-length': String(body.byteLength) }, 'charged');
  }

  public async getObject(key: string): Promise<Buffer> {
    const response = await this.request('GET', objectPath(key), undefined, {}, 'read');
    return Buffer.from(await response.arrayBuffer());
  }

  public async deleteObject(key: string): Promise<void> {
    await this.request('DELETE', objectPath(key), undefined, {}, 'free');
  }

  private async request(method: string, pathAndQuery: string, body: Uint8Array | undefined, extraHeaders: Record<string, string>, billing: Billing): Promise<Response> {
    for (let retry = 0; ; retry += 1) {
      const session = await this.options.session();
      const url = new URL(`${session.baseUrl}${pathAndQuery}`);
      // Signed exactly as the Worker will read it back: pathname plus search, after URL normalisation.
      const headers = { ...signWorkerRequest(session, method, `${url.pathname}${url.search}`, this.now()), ...extraHeaders };
      const response = await this.fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body: body as BodyInit }) });
      const delay = SETTLE_RETRY_DELAYS_MS[retry];
      if (response.status === 401 && delay !== undefined) {
        // Rotation replaces the key at once, so a request signed just before it
        // is refused. If there is a newer key now, that is the whole story.
        const latest = await this.options.session();
        const rotated = latest.key !== session.key;
        if (rotated || this.now() - session.issuedAt < WORKER_KEY_SETTLE_MS) {
          await response.body?.cancel().catch(() => undefined);
          if (!rotated) await this.sleep(delay);
          continue;
        }
      }
      // A refused request never reached the bucket, so only one that did is counted.
      if (response.status !== 401) this.options.onRequest(billing);
      return await checked(response);
    }
  }
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const parsed: unknown = await response.json().catch(() => null);
  const reason = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : response.statusText;
  throw new R2HttpError(response.status, `Backup Worker request failed (${response.status}): ${reason || 'no detail'}`);
}

function objectPath(key: string): string {
  return `/v1/o/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
