import { randomBytes } from 'node:crypto';
import { R2Error, R2HttpError, type ObjectRecord, type ObjectStore } from './store.js';

/**
 * A folder in the user's Google Drive as an object store.
 *
 * Every object is one file whose name is its key, so a key needs no index of
 * its own and the folder can be read by a person: two folders the manager
 * created, "SillyTavern Manager" with the few named files (the claim, the
 * settings, the recovery point lists), and "data" inside it with the content
 * chunks, which are thousands of files nobody needs to look at.
 *
 * Drive has no "get by key"; a name has to be searched for, and a search is
 * the most expensive call it has. So a listing of both folders is kept and
 * used to find files, rebuilt whenever a listing is asked for from the start
 * and fetched once on first use. Chunks are named by their content, so a chunk
 * is created without looking first: if one by that name is already there, the
 * second copy holds the same bytes and is dropped from the listing.
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,size,modifiedTime,md5Checksum';
const LIST_PAGE = 1000;
const MAX_ATTEMPTS = 6;

export interface DriveFolders {
  readonly root: string;
  readonly data: string;
}

export interface DriveStoreOptions {
  /** A current access token. */
  readonly token: () => Promise<string>;
  /** Told when Drive refused the token, so the next call refreshes it. */
  readonly invalidate: () => void;
  readonly folders: () => Promise<DriveFolders>;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly modifiedTime: string | null;
  readonly md5: string | null;
}

/** Content chunks, named by their hash, which go in the `data` folder. */
export function isChunkKey(key: string): boolean {
  return key.includes('/blobs/');
}

export class DriveObjectStore implements ObjectStore {
  private readonly options: DriveStoreOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private index: Map<string, DriveFile> | null = null;
  private indexing: Promise<Map<string, DriveFile>> | null = null;
  /** The listing a paged read is walking, so later pages match the first. */
  private listing: ObjectRecord[] = [];

  public constructor(options: DriveStoreOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  public async listObjects(prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: ObjectRecord[]; cursor: string | undefined }> {
    const offset = cursor ? Number(cursor) : 0;
    if (!cursor || !Number.isInteger(offset) || offset < 0) {
      // A listing from the start is somebody asking what is there now.
      const index = await this.rebuildIndex();
      this.listing = [...index.values()]
        .filter((file) => file.name.startsWith(prefix))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((file) => ({ key: file.name, sizeBytes: file.size, lastModified: file.modifiedTime, etag: file.md5 }));
      return this.page(0, maxKeys);
    }
    return this.page(offset, maxKeys);
  }

  public async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const folders = await this.options.folders();
    const existing = await this.find(key);
    if (existing) {
      try {
        const updated = await this.json<Record<string, unknown>>(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=${FILE_FIELDS}`, {
          method: 'PATCH',
          headers: { 'content-type': contentType },
          body: new Uint8Array(body),
        });
        this.remember(toDriveFile(updated) ?? { ...existing, size: body.byteLength });
        return;
      } catch (error: unknown) {
        // Removed since the listing was read, by another machine's sweep or
        // by hand in Drive. Made again below.
        if (!(error instanceof R2HttpError) || error.status !== 404) throw error;
        this.index?.delete(key);
      }
    }
    const boundary = `stm${randomBytes(12).toString('hex')}`;
    const metadata = JSON.stringify({ name: key, parents: [isChunkKey(key) ? folders.data : folders.root], mimeType: contentType });
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`, 'utf8'),
      Buffer.from(body),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const created = await this.json<Record<string, unknown>>(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    const file = toDriveFile(created);
    if (file) this.remember(file);
  }

  public async getObject(key: string): Promise<Buffer> {
    const file = await this.find(key);
    if (!file) throw new R2HttpError(404, `Google Drive has no file for ${key}`);
    const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, { method: 'GET' });
    return Buffer.from(await response.arrayBuffer());
  }

  public async deleteObject(key: string): Promise<void> {
    const file = await this.find(key);
    if (!file) return;
    try {
      await this.request(`${DRIVE_API}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
    } catch (error: unknown) {
      if (!(error instanceof R2HttpError) || error.status !== 404) throw error;
    }
    this.index?.delete(key);
  }

  private page(offset: number, maxKeys: number): { objects: ObjectRecord[]; cursor: string | undefined } {
    const end = offset + Math.max(1, maxKeys);
    return { objects: this.listing.slice(offset, end), cursor: end < this.listing.length ? String(end) : undefined };
  }

  /**
   * The file holding `key`.
   *
   * A chunk is looked up in the listing when there is one: chunks are named by
   * their content and never change. Before a listing exists a chunk is taken
   * as absent, which costs at worst a second copy of the same bytes. Every
   * other key - the claim, the settings, the recovery point lists - is searched
   * for each time, because another machine may have written it since.
   */
  private async find(key: string): Promise<DriveFile | null> {
    if (isChunkKey(key)) return this.index?.get(key) ?? null;
    const folders = await this.options.folders();
    const folder = isChunkKey(key) ? folders.data : folders.root;
    const query = `name = '${escapeQuery(key)}' and '${escapeQuery(folder)}' in parents and trashed = false`;
    const found = await this.json<{ files?: unknown[] }>(`${DRIVE_API}/files?${new URLSearchParams({ q: query, fields: `files(${FILE_FIELDS})`, pageSize: '10', orderBy: 'modifiedTime desc', spaces: 'drive' }).toString()}`, { method: 'GET' });
    const file = (found.files ?? []).map(toDriveFile).find((entry): entry is DriveFile => entry !== null) ?? null;
    return file;
  }

  private remember(file: DriveFile): void {
    this.index?.set(file.name, file);
  }

  private async rebuildIndex(): Promise<Map<string, DriveFile>> {
    if (!this.indexing) {
      this.indexing = this.readIndex().then((index) => { this.index = index; return index; }).finally(() => { this.indexing = null; });
    }
    return await this.indexing;
  }

  private async readIndex(): Promise<Map<string, DriveFile>> {
    const folders = await this.options.folders();
    const index = new Map<string, DriveFile>();
    const query = `('${escapeQuery(folders.root)}' in parents or '${escapeQuery(folders.data)}' in parents) and trashed = false and mimeType != '${FOLDER_MIME}'`;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: String(LIST_PAGE), spaces: 'drive' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.json<{ files?: unknown[]; nextPageToken?: unknown }>(`${DRIVE_API}/files?${params.toString()}`, { method: 'GET' });
      for (const value of page.files ?? []) {
        const file = toDriveFile(value);
        if (!file) continue;
        // Two files under one name: a create that was retried after it had in
        // fact gone through. The newest is the one a reader means.
        const seen = index.get(file.name);
        if (!seen || (file.modifiedTime ?? '') > (seen.modifiedTime ?? '')) index.set(file.name, file);
      }
      pageToken = typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : undefined;
    } while (pageToken);
    return index;
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.request(url, init);
    return await response.json() as T;
  }

  /**
   * One request, with the waiting Drive asks for.
   *
   * Drive answers a busy moment with 429, a 5xx, or a 403 whose reason is a
   * rate limit, and wants the caller to back off and try again. A 401 is an
   * access token that ended early; it is refreshed once.
   */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.options.token();
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
      } catch (error: unknown) {
        if (attempt >= MAX_ATTEMPTS) throw new R2Error('google_drive_unreachable', `Google Drive could not be reached: ${error instanceof Error ? error.message : 'network error'}`);
        await this.backOff(attempt, null);
        continue;
      }
      if (response.ok) return response;
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.options.invalidate();
        continue;
      }
      const text = await response.text().catch(() => '');
      const reason = driveReason(text);
      const retriable = response.status === 429 || response.status >= 500 || (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/u.test(reason));
      if (retriable && attempt < MAX_ATTEMPTS) {
        await this.backOff(attempt, response.headers.get('retry-after'));
        continue;
      }
      if (response.status === 403 && /storageQuotaExceeded/u.test(reason)) {
        throw new R2Error('google_drive_full', 'Google Drive is full. Free some space in the Google account, then back up again.');
      }
      throw new R2HttpError(response.status, `Google Drive answered ${response.status}${reason ? ` (${reason})` : ''}`);
    }
  }

  private async backOff(attempt: number, retryAfter: string | null): Promise<void> {
    const asked = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
    const wait = Number.isFinite(asked) && asked > 0 ? asked : Math.min(32_000, 1000 * 2 ** (attempt - 1)) + Math.floor(this.random() * 1000);
    await this.sleep(wait);
  }
}

function toDriveFile(value: unknown): DriveFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return null;
  const size = Number(record.size ?? 0);
  return {
    id: record.id,
    name: record.name,
    size: Number.isFinite(size) ? size : 0,
    modifiedTime: typeof record.modifiedTime === 'string' ? record.modifiedTime : null,
    md5: typeof record.md5Checksum === 'string' ? record.md5Checksum : null,
  };
}

/** Drive's machine-readable reason for a refusal, from its JSON error body. */
function driveReason(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown; message?: unknown } };
    const reasons = (parsed.error?.errors ?? []).map((entry) => (typeof entry.reason === 'string' ? entry.reason : '')).filter(Boolean);
    if (reasons.length > 0) return reasons.join(',');
    return typeof parsed.error?.status === 'string' ? parsed.error.status : '';
  } catch {
    return '';
  }
}

/** A value inside a single-quoted Drive query string. */
export function escapeQuery(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}
