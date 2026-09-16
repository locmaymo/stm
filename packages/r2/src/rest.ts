import { CLOUDFLARE_API_BASE, parseRateLimit, type R2Jurisdiction } from '../../cloudflare/src/index.js';
import { R2Error, R2HttpError, type Billing, type ObjectRecord, type ObjectStore } from './store.js';

/** Cloudflare's documented limit: 1,200 requests per user per five minutes. */
const API_WINDOW_MS = 5 * 60 * 1000;
/**
 * How much of that limit backups may take.
 *
 * The limit is the user's, not the manager's: the dashboard, wrangler and every
 * other tool they run draw from it too, and going over blocks all of them for
 * five minutes. A quarter is left for them.
 */
const DEFAULT_BUDGET = 900;
/** When Cloudflare says this few are left, wait for the window to reset rather than take them. */
const RESERVE = 100;

export interface RestObjectStoreOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly jurisdiction?: R2Jurisdiction;
  /** Called for every request, so an access token that expired meanwhile is refreshed. */
  readonly accessToken: () => Promise<string>;
  readonly onRequest: (billing: Billing) => void;
  readonly fetchImpl?: typeof fetch;
  /** Shared by every store talking for the same user, since the limit is per user. */
  readonly pacer?: RequestPacer;
  readonly baseUrl?: string;
}

/**
 * The bucket over Cloudflare's REST API, with the OAuth access token.
 *
 * The slow way in, used when there is no Worker to go through: every request
 * counts against the user's API rate limit, so this store paces itself instead
 * of finding the limit by hitting it.
 */
export class RestObjectStore implements ObjectStore {
  private readonly options: RestObjectStoreOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly pacer: RequestPacer;
  private readonly baseUrl: string;

  public constructor(options: RestObjectStoreOptions) {
    if (!/^[0-9a-f]{32}$/u.test(options.accountId)) throw new R2Error('invalid_r2_account', 'The Cloudflare account ID is not valid');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(options.bucket)) throw new R2Error('invalid_r2_bucket', 'R2 bucket name is invalid');
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pacer = options.pacer ?? new RequestPacer();
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/u, '');
  }

  public async listObjects(prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: ObjectRecord[]; cursor: string | undefined }> {
    const query = new URLSearchParams([['prefix', prefix], ['per_page', String(Math.min(Math.max(maxKeys, 1), 1000))]]);
    if (cursor) query.set('cursor', cursor);
    const response = await this.request('GET', this.objectsPath(), query, undefined, {}, 'charged');
    const parsed: unknown = await response.json().catch(() => null);
    if (!isRecord(parsed) || parsed.success !== true || !Array.isArray(parsed.result)) throw new R2HttpError(response.status, 'R2 REST listing returned an unreadable response');
    const objects: ObjectRecord[] = [];
    for (const entry of parsed.result) {
      if (!isRecord(entry) || typeof entry.key !== 'string' || !entry.key) continue;
      const size = Number(entry.size ?? 0);
      objects.push({
        key: entry.key,
        sizeBytes: Number.isFinite(size) ? size : 0,
        lastModified: typeof entry.last_modified === 'string' ? entry.last_modified : null,
        etag: typeof entry.etag === 'string' ? entry.etag : null,
      });
    }
    const info = isRecord(parsed.result_info) ? parsed.result_info : {};
    const next = info.is_truncated === true && typeof info.cursor === 'string' && info.cursor ? info.cursor : undefined;
    return { objects, cursor: next };
  }

  public async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.request('PUT', this.objectsPath(key), undefined, body, { 'content-type': contentType }, 'charged');
  }

  public async getObject(key: string): Promise<Buffer> {
    const response = await this.request('GET', this.objectsPath(key), undefined, undefined, {}, 'read');
    return Buffer.from(await response.arrayBuffer());
  }

  public async deleteObject(key: string): Promise<void> {
    await this.request('DELETE', this.objectsPath(key), undefined, undefined, {}, 'free');
  }

  private objectsPath(key?: string): string {
    const base = `/accounts/${this.options.accountId}/r2/buckets/${this.options.bucket}/objects`;
    // Slashes in a key are sent as they are; Cloudflare reads `%2F` as part of a name.
    return key === undefined ? base : `${base}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
  }

  private async request(method: string, path: string, query: URLSearchParams | undefined, body: Uint8Array | undefined, extraHeaders: Record<string, string>, billing: Billing): Promise<Response> {
    await this.pacer.acquire();
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) url.search = query.toString();
    const headers: Record<string, string> = { authorization: `Bearer ${await this.options.accessToken()}`, ...extraHeaders };
    if (this.options.jurisdiction && this.options.jurisdiction !== 'default') headers['cf-r2-jurisdiction'] = this.options.jurisdiction;
    this.options.onRequest(billing);
    const response = await this.fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body: body as BodyInit }) });
    this.pacer.observe(response.headers);
    if (response.status === 429) {
      const seconds = retryAfterSeconds(response.headers);
      this.pacer.pauseFor(seconds * 1000);
      throw new R2Error('r2_rate_limited', `Cloudflare's API rate limit was reached; backups over the REST API resume in ${seconds} seconds`);
    }
    if (!response.ok) throw new R2HttpError(response.status, `R2 REST request failed (${response.status}): ${await errorDetail(response)}`);
    return response;
  }
}

export interface RequestPacerOptions {
  readonly budget?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Keeps requests under the API rate limit before Cloudflare has to say so.
 *
 * Two things slow it down: its own count of the requests made in the last five
 * minutes, and what Cloudflare's `Ratelimit` header says is left, which also
 * sees the requests the user made elsewhere.
 */
export class RequestPacer {
  private readonly budget: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly sent: number[] = [];
  private pausedUntil = 0;

  public constructor(options: RequestPacerOptions = {}) {
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.windowMs = options.windowMs ?? API_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** Wait until one more request fits, then count it. */
  public async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.sent.length > 0 && (this.sent[0] ?? 0) <= now - this.windowMs) this.sent.shift();
      const untilWindow = this.sent.length >= this.budget ? (this.sent[0] ?? now) + this.windowMs - now : 0;
      const wait = Math.max(untilWindow, this.pausedUntil - now);
      if (wait <= 0) {
        // Checked and counted without awaiting in between, so callers running
        // side by side cannot all see the same free slot.
        this.sent.push(now);
        return;
      }
      await this.sleep(wait);
    }
  }

  public observe(headers: Headers): void {
    const limit = parseRateLimit(headers.get('ratelimit'));
    if (limit && limit.remaining <= RESERVE) this.pauseFor(Math.max(limit.resetSeconds, 1) * 1000);
  }

  public pauseFor(milliseconds: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + milliseconds);
  }
}

function retryAfterSeconds(headers: Headers): number {
  const seconds = Number(headers.get('retry-after'));
  // Going over the limit is documented as a five-minute block.
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 300;
}

async function errorDetail(response: Response): Promise<string> {
  const parsed: unknown = await response.json().catch(() => null);
  const errors = isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors : [];
  const detail = errors.map((error) => (isRecord(error) && typeof error.message === 'string' ? error.message : '')).filter(Boolean).join('; ');
  return (detail || response.statusText || 'no detail').slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
