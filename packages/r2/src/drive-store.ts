import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { R2Error, R2HttpError, type ObjectRecord, type ObjectStore } from './store.js';

/**
 * The app's hidden folder in the user's Google Drive as an object store.
 *
 * Drive is slow per request and fast per byte. Measured from a home line in
 * 2026-10: about 1.8 seconds to create a file however small, about one second
 * to read one back, no throttling up to 32 requests at once, and 10 to 18 MiB/s
 * for large files sent several at a time. A profile is thousands of small
 * files, so one Drive file per content chunk spent nearly all of its time
 * waiting: 2,748 files took seven and a half minutes to read back.
 *
 * So small chunks travel in packs. A pack is one Drive file holding many
 * chunks, with its own table of contents at the front:
 *
 *   "STMPACK1" | u32 big-endian header length | gzip(JSON header) | chunk bytes
 *
 * The header names every chunk it holds by its key, so the packs alone are
 * enough to find any chunk again: a new machine reads the front of each pack
 * (one ranged request each) and knows where everything is. Chunks of a megabyte
 * or more are worth a request of their own and still go one per file.
 *
 * Above this, nothing knows about packs. A packed chunk is listed, read and
 * deleted by its key like any other object; `flush` is the one thing a caller
 * has to do, before it records a chunk as stored. A chunk deleted out of a pack
 * leaves its bytes there until `compact` rewrites or removes the pack.
 *
 * Every other object - the claim, the settings, the recovery point lists - is a
 * file named by its key. Drive has no "get by key", and a search is its most
 * expensive call, so a listing is kept and searched instead, rebuilt whenever
 * a listing is asked for from the start.
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** The app's hidden folder: the parent to create in and the space to search. */
export const APP_DATA_FOLDER = 'appDataFolder';
const FILE_FIELDS = 'id,name,size,modifiedTime,md5Checksum';
const LIST_PAGE = 1000;
const MAX_ATTEMPTS = 6;

const PACK_MAGIC = Buffer.from('STMPACK1', 'ascii');
const PACK_PREAMBLE = PACK_MAGIC.byteLength + 4;
/** Pack file names; outside every key the manager uses, so a listing never shows them. */
const PACK_PREFIX = 'stm-packs/';
/** A pack is sent once it holds this much. Large enough that a request's wait is small beside its bytes. */
export const PACK_TARGET_BYTES = 8 * 1024 * 1024;
const PACK_MAX_ENTRIES = 4000;
/** A chunk this large is sent as a file of its own. */
export const SOLO_MIN_BYTES = 1024 * 1024;
/** Packs being sent at once; each is held in memory until Drive has it. */
const PACK_UPLOADS = 4;
/** Whole packs kept after reading one chunk, for the chunks beside it that come next. */
const PACK_CACHE_BYTES = 48 * 1024 * 1024;
/** How much of a pack's front is read to find its table of contents. */
const HEADER_PROBE_BYTES = 256 * 1024;
/** Requests at once when reading many tables of contents or removing many files. */
const DRIVE_PARALLEL = 8;
/**
 * Files sent or read at once by a backup or a restore to Drive.
 *
 * Drive spends most of each request waiting, so more at once is faster until
 * the line is full: on the 677 MiB test profile, 16 sent it in 52 s against
 * 140 s with 8, and read it back in 58 s against 72 s.
 */
export const DRIVE_TRANSFERS = 16;
/** A pack with less than this share of its bytes still wanted is rewritten. */
const REPACK_LIVE_SHARE = 0.5;
/** Small packs and small single chunks are gathered into full packs once there are this many. */
const LOOSE_GATHER_COUNT = 16;
/**
 * How long a request may go without an answer before it is sent again: this,
 * plus a second for every `STALL_BYTES_PER_SECOND` it carries, doubled on each
 * attempt so a slow line still gets through.
 *
 * Drive now and then holds one upload for two minutes and more, measured in
 * 2026-10 - a 1.2 MB file that normally takes two seconds - while everything
 * else is long done. A backup waited on it every time.
 */
const STALL_BASE_MS = 20_000;
const STALL_BYTES_PER_SECOND = 256 * 1024;

export interface DriveStoreOptions {
  /** A current access token. */
  readonly token: () => Promise<string>;
  /** Told when Drive refused the token, so the next call refreshes it. */
  readonly invalidate: () => void;
  /** Throws when the connection cannot be used, before any request is made. */
  readonly ready: () => Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  /** Overrides for tests; see the constants above. */
  readonly packTargetBytes?: number;
  readonly soloMinBytes?: number;
  readonly stallBaseMs?: number;
}

interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly modifiedTime: string | null;
  readonly md5: string | null;
}

/** Where one chunk sits inside a pack, as its header says; `offset` counts from the first chunk byte. */
interface PackEntry {
  readonly key: string;
  readonly offset: number;
  readonly length: number;
}

interface PackContents {
  /** Where chunk bytes start in the pack file. */
  readonly dataStart: number;
  readonly entries: readonly PackEntry[];
}

interface PackedLocation {
  readonly pack: DriveFile;
  readonly dataStart: number;
  readonly entry: PackEntry;
}

/** Content chunks, named by their hash: never rewritten, so never looked up before being sent. */
export function isChunkKey(key: string): boolean {
  return key.includes('/blobs/');
}

/** Recovery point lists: written once under a new name, never rewritten. */
function isWriteOnceKey(key: string): boolean {
  return isChunkKey(key) || key.includes('/snapshots/');
}

function isPackName(name: string): boolean {
  return name.startsWith(PACK_PREFIX);
}

export class DriveObjectStore implements ObjectStore {
  private readonly options: DriveStoreOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly packTarget: number;
  private readonly soloMin: number;
  private readonly stallBase: number;
  /** Every file in the app folder by name, packs included. */
  private index: Map<string, DriveFile> | null = null;
  private indexing: Promise<Map<string, DriveFile>> | null = null;
  /** Packed chunks by key; the newest pack holding a key is the one used. */
  private packed = new Map<string, PackedLocation>();
  /** Pack tables of contents by Drive file id. A pack never changes, so one read lasts. */
  private readonly contents = new Map<string, PackContents>();
  /**
   * Chunks deleted out of packs that still hold their bytes. A pack's table of
   * contents still names them, so a listing read again would bring them back.
   */
  private readonly removed = new Set<string>();
  /** Chunks sent as files of their own by this process, before any listing knows them. */
  private readonly sent = new Set<string>();
  /** The listing a paged read is walking, so later pages match the first. */
  private listing: ObjectRecord[] = [];
  /** Chunks waiting to be sent in the next pack. */
  private pending: Array<{ key: string; body: Buffer }> = [];
  private pendingBytes = 0;
  private readonly uploads = new Set<Promise<void>>();
  private uploadFailure: unknown = null;
  /** Packs read whole, newest use last. */
  private readonly packCache = new Map<string, Promise<Buffer>>();
  /** Sizes of the cached packs that have arrived, which is what the cache limit counts. */
  private readonly packSizes = new Map<string, number>();
  private packCacheBytes = 0;

  public constructor(options: DriveStoreOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.packTarget = options.packTargetBytes ?? PACK_TARGET_BYTES;
    this.soloMin = options.soloMinBytes ?? SOLO_MIN_BYTES;
    this.stallBase = options.stallBaseMs ?? STALL_BASE_MS;
  }

  public async listObjects(prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: ObjectRecord[]; cursor: string | undefined }> {
    const offset = cursor ? Number(cursor) : 0;
    if (!cursor || !Number.isInteger(offset) || offset < 0) {
      // A listing from the start is somebody asking what is there now.
      const index = await this.rebuildIndex();
      const records: ObjectRecord[] = [];
      for (const file of index.values()) {
        if (isPackName(file.name) || !file.name.startsWith(prefix)) continue;
        records.push({ key: file.name, sizeBytes: file.size, lastModified: file.modifiedTime, etag: file.md5 });
      }
      for (const [key, location] of this.packed) {
        if (!key.startsWith(prefix) || index.has(key)) continue;
        records.push({ key, sizeBytes: location.entry.length, lastModified: location.pack.modifiedTime, etag: null });
      }
      this.listing = records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return this.page(0, maxKeys);
    }
    return this.page(offset, maxKeys);
  }

  public async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.options.ready();
    if (isChunkKey(key)) {
      this.throwUploadFailure();
      // Named by its content: already stored is already right.
      if (this.index?.has(key) || this.sent.has(key) || this.packed.has(key) || this.pending.some((entry) => entry.key === key)) return;
      if (body.byteLength >= this.soloMin) {
        await this.createFile(key, body, contentType);
        this.sent.add(key);
        return;
      }
      this.pending.push({ key, body: Buffer.from(body) });
      this.pendingBytes += body.byteLength;
      if (this.pendingBytes >= this.packTarget || this.pending.length >= PACK_MAX_ENTRIES) await this.sealPack();
      return;
    }
    // Anything else may name chunks sent before it, so those land first.
    await this.flush();
    const existing = isWriteOnceKey(key) ? null : await this.find(key);
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
        // Removed since the listing was read, by another machine's sweep.
        // Made again below.
        if (!(error instanceof R2HttpError) || error.status !== 404) throw error;
        this.index?.delete(key);
      }
    }
    await this.createFile(key, body, contentType);
  }

  public async getObject(key: string): Promise<Buffer> {
    for (let attempt = 0; ; attempt += 1) {
      const waiting = this.pending.find((entry) => entry.key === key);
      if (waiting) return Buffer.from(waiting.body);
      const solo = await this.find(key);
      try {
        if (solo) {
          const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(solo.id)}?alt=media`, { method: 'GET' });
          return Buffer.from(await response.arrayBuffer());
        }
        const location = this.packed.get(key);
        if (location) {
          const pack = await this.readPack(location.pack);
          const start = location.dataStart + location.entry.offset;
          if (pack.byteLength < start + location.entry.length) throw new R2Error('google_pack_damaged', `A backup pack in Google Drive is shorter than its table of contents says (${key})`);
          return Buffer.from(pack.subarray(start, start + location.entry.length));
        }
      } catch (error: unknown) {
        // Rewritten by another machine's tidy-up since the listing was read.
        if (attempt > 0 || !(error instanceof R2HttpError) || error.status !== 404) throw error;
        await this.rebuildIndex();
        continue;
      }
      // Never listed in this process, or listed before the chunk was sent.
      if (attempt > 0 || !isChunkKey(key)) throw new R2HttpError(404, `Google Drive has no file for ${key}`);
      await this.rebuildIndex();
    }
  }

  public async deleteObject(key: string): Promise<void> {
    if (isChunkKey(key)) {
      this.pending = this.pending.filter((entry) => entry.key !== key);
      this.sent.delete(key);
      const location = this.packed.get(key);
      if (location && !this.index?.has(key)) {
        this.packed.delete(key);
        this.removed.add(key);
        // The last chunk wanted from a pack takes the pack with it; a pack still
        // holding others waits for `compact`.
        if (!this.packStillUsed(location.pack.id)) await this.deleteFile(location.pack);
        return;
      }
    }
    const file = await this.find(key);
    if (file) await this.deleteFile(file);
  }

  /**
   * Send the chunks still waiting, and wait for every pack on its way.
   *
   * A caller records chunks as stored only after this returns. A pack that
   * failed fails this, once, so the run that sent it fails rather than
   * recording chunks Drive never received.
   */
  public async flush(): Promise<void> {
    if (this.pending.length > 0) await this.sealPack();
    while (this.uploads.size > 0) await Promise.allSettled([...this.uploads]);
    this.throwUploadFailure();
  }

  /**
   * Take back the space in packs that hold chunks nobody wants.
   *
   * Run after the sweep has deleted what no recovery point names. A pack
   * nobody wants anything from is removed; one that is mostly unwanted, and the
   * small packs and small single chunks frequent backups leave behind, are
   * gathered into full packs, so the number of files a restore has to read
   * stays near what the data needs.
   *
   * New packs land before old ones go. Stopped between the two, the same chunk
   * is in two packs; the newer is the one used, and the older one is collected
   * by the next run.
   */
  public async compact(): Promise<{ readonly removedPacks: number; readonly rewrittenPacks: number; readonly gatheredFiles: number }> {
    await this.flush();
    const index = await this.rebuildIndex();
    const used = new Map<string, number>();
    for (const location of this.packed.values()) used.set(location.pack.id, (used.get(location.pack.id) ?? 0) + location.entry.length);
    let removedPacks = 0;
    const rewrite: DriveFile[] = [];
    const loose: DriveFile[] = [];
    for (const file of index.values()) {
      if (isPackName(file.name)) {
        const live = used.get(file.id) ?? 0;
        if (live === 0) {
          await this.deleteFile(file);
          removedPacks += 1;
        } else if (live < file.size * REPACK_LIVE_SHARE) {
          rewrite.push(file);
        } else if (file.size < this.packTarget / 4) {
          loose.push(file);
        }
      } else if (isChunkKey(file.name) && file.size < this.soloMin) {
        loose.push(file);
      }
    }
    const gather = loose.length >= LOOSE_GATHER_COUNT ? loose : [];
    const moved = [...rewrite, ...gather];
    for (const file of moved) {
      if (isPackName(file.name)) {
        const pack = await this.readPack(file);
        for (const [key, location] of this.packed) {
          if (location.pack.id !== file.id) continue;
          const start = location.dataStart + location.entry.offset;
          this.pending.push({ key, body: Buffer.from(pack.subarray(start, start + location.entry.length)) });
          this.pendingBytes += location.entry.length;
          if (this.pendingBytes >= this.packTarget || this.pending.length >= PACK_MAX_ENTRIES) await this.sealPack();
        }
      } else {
        const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, { method: 'GET' });
        this.pending.push({ key: file.name, body: Buffer.from(await response.arrayBuffer()) });
        this.pendingBytes += file.size;
        if (this.pendingBytes >= this.packTarget || this.pending.length >= PACK_MAX_ENTRIES) await this.sealPack();
      }
    }
    // Into packs even if what is left is a single chunk: it is leaving a file of its own.
    if (this.pending.length > 0) await this.sealPack({ allowSingle: false });
    await this.flush();
    await runLimited(moved, DRIVE_PARALLEL, async (file) => {
      if (!isPackName(file.name)) this.index?.delete(file.name);
      await this.deleteFile(file);
    });
    return { removedPacks, rewrittenPacks: rewrite.length, gatheredFiles: gather.length };
  }

  /** Remove every file this app has in the Drive: the "delete the backups too" of signing out. */
  public async deleteEverything(): Promise<{ readonly files: number; readonly bytes: number }> {
    this.pending = [];
    this.pendingBytes = 0;
    while (this.uploads.size > 0) await Promise.allSettled([...this.uploads]);
    this.uploadFailure = null;
    const index = await this.rebuildIndex();
    const files = [...index.values()];
    await runLimited(files, DRIVE_PARALLEL, async (file) => { await this.deleteFile(file); });
    this.packed.clear();
    this.removed.clear();
    this.sent.clear();
    this.packCache.clear();
    this.packSizes.clear();
    this.packCacheBytes = 0;
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  }

  /** What the app's files take in the Drive: from the last listing, or a new one when there is none. */
  public async storedBytes(): Promise<{ readonly files: number; readonly bytes: number }> {
    const index = this.index ?? await this.rebuildIndex();
    let bytes = 0;
    for (const file of index.values()) bytes += file.size;
    return { files: index.size, bytes };
  }

  private page(offset: number, maxKeys: number): { objects: ObjectRecord[]; cursor: string | undefined } {
    const end = offset + Math.max(1, maxKeys);
    return { objects: this.listing.slice(offset, end), cursor: end < this.listing.length ? String(end) : undefined };
  }

  /** Close the pending pack and start sending it, waiting first if enough are already on their way. */
  private async sealPack(options: { readonly allowSingle?: boolean } = {}): Promise<void> {
    const entries = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    if (entries.length === 0) return;
    while (this.uploads.size >= PACK_UPLOADS) await Promise.race(this.uploads);
    this.throwUploadFailure();
    // One chunk alone - a frequent backup that changed one file - gains nothing from a pack.
    const single = entries.length === 1 && options.allowSingle !== false ? entries[0] : undefined;
    const upload = (single ? this.createFile(single.key, single.body, 'application/octet-stream').then(() => { this.sent.add(single.key); }) : this.sendPack(entries))
      .catch((error: unknown) => { this.uploadFailure ??= error; });
    const tracked: Promise<void> = upload.finally(() => { this.uploads.delete(tracked); });
    this.uploads.add(tracked);
  }

  private async sendPack(entries: ReadonlyArray<{ key: string; body: Buffer }>): Promise<void> {
    let offset = 0;
    const table: Array<[string, number, number]> = [];
    for (const entry of entries) {
      table.push([entry.key, offset, entry.body.byteLength]);
      offset += entry.body.byteLength;
    }
    const header = gzipSync(Buffer.from(JSON.stringify({ v: 1, entries: table }), 'utf8'));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.byteLength, 0);
    const body = Buffer.concat([PACK_MAGIC, length, header, ...entries.map((entry) => entry.body)]);
    const name = `${PACK_PREFIX}${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomBytes(6).toString('hex')}.pack`;
    const file = await this.createFile(name, body, 'application/octet-stream');
    if (!file) return;
    const contents: PackContents = { dataStart: PACK_PREAMBLE + header.byteLength, entries: table.map(([key, at, size]) => ({ key, offset: at, length: size })) };
    this.contents.set(file.id, contents);
    for (const entry of contents.entries) {
      this.packed.set(entry.key, { pack: file, dataStart: contents.dataStart, entry });
      this.removed.delete(entry.key);
    }
  }

  private async createFile(name: string, body: Uint8Array, contentType: string): Promise<DriveFile | null> {
    const boundary = `stm${randomBytes(12).toString('hex')}`;
    const metadata = JSON.stringify({ name, parents: [APP_DATA_FOLDER], mimeType: contentType });
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
    return file;
  }

  private async deleteFile(file: DriveFile): Promise<void> {
    try {
      await this.request(`${DRIVE_API}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
    } catch (error: unknown) {
      if (!(error instanceof R2HttpError) || error.status !== 404) throw error;
    }
    if (this.index?.get(file.name)?.id === file.id) this.index.delete(file.name);
    if (isPackName(file.name)) this.forgetPack(file.id);
  }

  private forgetPack(id: string): void {
    for (const [key, location] of this.packed) if (location.pack.id === id) this.packed.delete(key);
    this.contents.delete(id);
    this.uncache(id);
  }

  private uncache(id: string): void {
    this.packCache.delete(id);
    this.packCacheBytes -= this.packSizes.get(id) ?? 0;
    this.packSizes.delete(id);
  }

  private packStillUsed(id: string): boolean {
    for (const location of this.packed.values()) if (location.pack.id === id) return true;
    return false;
  }

  /** A whole pack, from memory when it was read lately. */
  private async readPack(pack: DriveFile): Promise<Buffer> {
    const cached = this.packCache.get(pack.id);
    if (cached) {
      // Most recently used goes last.
      this.packCache.delete(pack.id);
      this.packCache.set(pack.id, cached);
      return await cached;
    }
    const loading = this.request(`${DRIVE_API}/files/${encodeURIComponent(pack.id)}?alt=media`, { method: 'GET' })
      .then(async (response) => Buffer.from(await response.arrayBuffer()));
    this.packCache.set(pack.id, loading);
    try {
      const bytes = await loading;
      if (this.packCache.get(pack.id) === loading && !this.packSizes.has(pack.id)) {
        this.packSizes.set(pack.id, bytes.byteLength);
        this.packCacheBytes += bytes.byteLength;
        this.trimPackCache(pack.id);
      }
      return bytes;
    } catch (error: unknown) {
      if (this.packCache.get(pack.id) === loading) this.packCache.delete(pack.id);
      throw error;
    }
  }

  private trimPackCache(keep: string): void {
    for (const id of [...this.packCache.keys()]) {
      if (this.packCacheBytes <= PACK_CACHE_BYTES) return;
      if (id !== keep) this.uncache(id);
    }
  }

  /** A pack's table of contents, read from its front. */
  private async readContents(pack: DriveFile): Promise<PackContents> {
    const known = this.contents.get(pack.id);
    if (known) return known;
    const probe = Math.min(HEADER_PROBE_BYTES, Math.max(PACK_PREAMBLE, pack.size));
    let front = await this.readRange(pack, 0, probe);
    if (front.byteLength < PACK_PREAMBLE || !front.subarray(0, PACK_MAGIC.byteLength).equals(PACK_MAGIC)) {
      throw new R2Error('google_pack_damaged', `A backup pack in Google Drive is not one this manager can read (${pack.name})`);
    }
    const headerLength = front.readUInt32BE(PACK_MAGIC.byteLength);
    const dataStart = PACK_PREAMBLE + headerLength;
    if (front.byteLength < dataStart) front = Buffer.concat([front, await this.readRange(pack, front.byteLength, dataStart)]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(gunzipSync(front.subarray(PACK_PREAMBLE, dataStart)).toString('utf8'));
    } catch {
      throw new R2Error('google_pack_damaged', `A backup pack in Google Drive has a table of contents that cannot be read (${pack.name})`);
    }
    const contents: PackContents = { dataStart, entries: parseEntries(parsed, pack.name) };
    this.contents.set(pack.id, contents);
    return contents;
  }

  /** Bytes `start` to `end` (exclusive) of a file. */
  private async readRange(file: DriveFile, start: number, end: number): Promise<Buffer> {
    const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, { method: 'GET', headers: { range: `bytes=${start}-${end - 1}` } });
    const bytes = Buffer.from(await response.arrayBuffer());
    // A server that ignored the range sent the whole file.
    return response.status === 206 ? bytes : bytes.subarray(start, end);
  }

  /**
   * The file holding `key` as a file of its own.
   *
   * A chunk is looked up in the listing, made on first use: chunks are named by
   * their content and never change. Every other key is searched for each time,
   * because another machine may have written it since.
   */
  private async find(key: string): Promise<DriveFile | null> {
    if (isChunkKey(key)) return (this.index ?? await this.rebuildIndex()).get(key) ?? null;
    await this.options.ready();
    const query = `name = '${escapeQuery(key)}' and trashed = false`;
    const found = await this.json<{ files?: unknown[] }>(`${DRIVE_API}/files?${new URLSearchParams({ q: query, fields: `files(${FILE_FIELDS})`, pageSize: '10', orderBy: 'modifiedTime desc', spaces: APP_DATA_FOLDER }).toString()}`, { method: 'GET' });
    return (found.files ?? []).map(toDriveFile).find((entry): entry is DriveFile => entry !== null) ?? null;
  }

  private remember(file: DriveFile): void {
    this.index?.set(file.name, file);
  }

  private async rebuildIndex(): Promise<Map<string, DriveFile>> {
    if (!this.indexing) {
      this.indexing = this.readIndex().finally(() => { this.indexing = null; });
    }
    return await this.indexing;
  }

  private async readIndex(): Promise<Map<string, DriveFile>> {
    await this.options.ready();
    const index = new Map<string, DriveFile>();
    const query = `trashed = false and mimeType != '${FOLDER_MIME}'`;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: String(LIST_PAGE), spaces: APP_DATA_FOLDER });
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

    // Oldest first, so a chunk in two packs ends up pointing at the newer one.
    const packs = [...index.values()].filter((file) => isPackName(file.name)).sort((a, b) => ((a.modifiedTime ?? '') < (b.modifiedTime ?? '') ? -1 : (a.modifiedTime ?? '') > (b.modifiedTime ?? '') ? 1 : a.name < b.name ? -1 : 1));
    const read = new Map<string, PackContents>();
    await runLimited(packs.filter((pack) => !this.contents.has(pack.id)), DRIVE_PARALLEL, async (pack) => { read.set(pack.id, await this.readContents(pack)); });
    const packed = new Map<string, PackedLocation>();
    const stillHeld = new Set<string>();
    for (const pack of packs) {
      const contents = this.contents.get(pack.id) ?? read.get(pack.id);
      if (!contents) continue;
      for (const entry of contents.entries) {
        if (this.removed.has(entry.key)) { stillHeld.add(entry.key); continue; }
        packed.set(entry.key, { pack, dataStart: contents.dataStart, entry });
      }
    }
    // A removed chunk no pack holds any more needs no remembering.
    for (const key of [...this.removed]) if (!stillHeld.has(key)) this.removed.delete(key);
    for (const key of [...this.sent]) if (index.has(key)) this.sent.delete(key);
    // Forget what was read for packs that are gone.
    const present = new Set(packs.map((pack) => pack.id));
    for (const id of [...this.contents.keys()]) if (!present.has(id)) this.forgetPack(id);
    this.index = index;
    this.packed = packed;
    return index;
  }

  private throwUploadFailure(): void {
    const failure = this.uploadFailure;
    if (failure === null) return;
    this.uploadFailure = null;
    throw failure;
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
   * access token that ended early; it is refreshed once. A request with no
   * answer in time is given up and sent again; see `STALL_BASE_MS`. Sending a
   * file again that had in fact arrived leaves two under one name, which the
   * listing already settles by taking the newer.
   */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let refreshed = false;
    const sending = init.body instanceof Uint8Array ? init.body.byteLength : 0;
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.options.token();
      let response: Response;
      const stall = new AbortController();
      const timer = setTimeout(() => stall.abort(), (this.stallBase + Math.ceil(sending / STALL_BYTES_PER_SECOND) * 1000) * 2 ** (attempt - 1));
      try {
        response = await this.fetchImpl(url, { ...init, signal: stall.signal, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
      } catch (error: unknown) {
        const reason = stall.signal.aborted ? 'no answer in time' : error instanceof Error ? error.message : 'network error';
        if (attempt >= MAX_ATTEMPTS) throw new R2Error('google_drive_unreachable', `Google Drive could not be reached: ${reason}`);
        await this.backOff(attempt, null);
        continue;
      } finally {
        // The answer has started; reading its body is not held to the limit.
        clearTimeout(timer);
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

function parseEntries(value: unknown, name: string): PackEntry[] {
  const entries = typeof value === 'object' && value !== null ? (value as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries)) throw new R2Error('google_pack_damaged', `A backup pack in Google Drive has no table of contents (${name})`);
  return entries.map((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Number.isSafeInteger(entry[1]) || !Number.isSafeInteger(entry[2]) || (entry[1] as number) < 0 || (entry[2] as number) < 0) {
      throw new R2Error('google_pack_damaged', `A backup pack in Google Drive has an entry that cannot be read (${name})`);
    }
    return { key: entry[0], offset: entry[1] as number, length: entry[2] as number };
  });
}

async function runLimited<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && failure === null) {
      const item = items[next]!;
      next += 1;
      try {
        await worker(item);
      } catch (error: unknown) {
        failure ??= error;
      }
    }
  }));
  if (failure !== null) throw failure;
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
