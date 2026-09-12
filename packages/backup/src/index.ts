import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDeflateRaw, createInflateRaw, crc32 } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { pipeline } from 'node:stream/promises';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { BackupFilePreview, BackupManifest, BackupSource, Profile, ProfileLayout, RestoreMode, RestorePreview } from '../../contracts/src/index.js';
import { createIoLimiter, ioConcurrency, runPooled } from '../../platform/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const BACKUP_STATE_FILE = 'backups.json';
const BACKUP_SCHEMA_VERSION = 1 as const;
const MAX_ZIP_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;
const DEFAULT_USER_HANDLE = 'default-user';
const PRESERVED_DATA_ROOT_NAMES = new Set(['_storage', '_cache', '_uploads', '_webpack', 'cookie-secret.txt']);
const PRESERVED_EXCLUDED_NAMES = new Set(['secrets.json', 'thumbnails', 'vectors', 'backups']);
const EXCLUDED_NAMES = new Set(['secrets.json', 'thumbnails', 'vectors', 'backups', '.git', 'node_modules', '.DS_Store', 'Thumbs.db']);
const RECOGNIZED_DATA_NAMES = new Set(['settings.json', 'characters', 'chats', 'worlds', 'groups', 'movingUI']);
const STAGING_PREFIX = '.stm-restore-';
const TRASH_PREFIX = '.stm-trash-';

export interface BackupStoreOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  readonly logger?: (line: string) => void;
}

export interface CreateBackupOptions {
  readonly name?: string;
  readonly includeSecrets?: boolean;
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
}

export interface RestoreOptions {
  readonly mode: RestoreMode;
  readonly allowSecrets?: boolean;
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
  readonly onStatus?: (step: string) => void;
}

interface PersistedBackups {
  readonly schemaVersion: 1;
  readonly backups: BackupManifest[];
}

interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compression: number;
  readonly localOffset: number;
  readonly directory: boolean;
  readonly symlink: boolean;
}

interface ArchiveSource {
  readonly name: string;
  readonly path: string;
}

interface UploadState {
  readonly schemaVersion: 1;
  readonly nextIndex: number;
  readonly bytes: number;
}

export class BackupStore {
  readonly paths: PlatformPaths;
  private readonly now: () => Date;
  private readonly logger: (line: string) => void;
  private manifests: BackupManifest[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();
  private cleanupTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  public constructor(options: BackupStoreOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(line));
  }

  public async list(profileId?: string): Promise<BackupManifest[]> {
    const manifests = await this.load();
    return manifests.filter((manifest) => !profileId || manifest.profileId === profileId).map((manifest) => ({ ...manifest }));
  }

  public async get(id: string): Promise<BackupManifest | null> {
    return (await this.load()).find((manifest) => manifest.id === id) ?? null;
  }

  public async getArchivePath(id: string): Promise<string | null> {
    const manifest = await this.get(id);
    if (!manifest) return null;
    const path = join(this.paths.archives, `${manifest.id}.zip`);
    try {
      await stat(path);
      return path;
    } catch (error: unknown) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  /** Return a cheap change fingerprint without reading user content into memory. */
  public async fingerprint(profile: Profile): Promise<string> {
    const root = await resolveProfileDataRoot(profile);
    let fileCount = 0;
    let totalBytes = 0;
    let newestMtime = 0;
    // The totals do not depend on visit order, so the stats run in parallel.
    // This runs on every scheduler tick, and a hosted volume charges a network
    // round trip for each one.
    const limiter = createIoLimiter(ioConcurrency());
    const visit = async (current: string): Promise<void> => {
      let details;
      try {
        details = await limiter.run(() => lstat(current));
      } catch (error: unknown) {
        if (isFileNotFound(error)) return;
        throw error;
      }
      if (details.isSymbolicLink()) throw new BackupError('linked_path', `Linked data path is not allowed: ${current}`);
      newestMtime = Math.max(newestMtime, details.mtimeMs);
      if (!details.isDirectory()) {
        fileCount += 1;
        totalBytes += details.size;
        return;
      }
      const children = (await limiter.run(() => readdir(current))).filter((child) => !EXCLUDED_NAMES.has(child));
      await Promise.all(children.map((child) => visit(join(current, child))));
    };
    await visit(root);
    if (await exists(profile.configPath)) {
      const configDetails = await lstat(profile.configPath);
      fileCount += 1;
      totalBytes += configDetails.size;
      newestMtime = Math.max(newestMtime, configDetails.mtimeMs);
    }
    return createHash('sha256').update(`${fileCount}:${totalBytes}:${Math.floor(newestMtime)}`, 'utf8').digest('hex');
  }

  public async create(profile: Profile, options: CreateBackupOptions = {}): Promise<BackupManifest> {
    const release = await this.acquireOperation();
    try {
      return await this.createUnlocked(profile, options);
    } finally {
      release();
    }
  }

  /** Prevent a scheduled backup from racing a restore or another manual backup. */
  public isOperationRunning(): boolean { return this.pendingOperations > 0; }

  private async createUnlocked(profile: Profile, options: CreateBackupOptions = {}): Promise<BackupManifest> {
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    const fingerprint = await this.fingerprint(profile);
    // Keep the temporary archive beside its final target. A container often
    // has /tmp on a different filesystem from its persistent /data volume;
    // writing there would make the final rename fail with EXDEV.
    const temporary = join(this.paths.archives, `.${id}.zip.tmp`);
    const target = join(this.paths.archives, `${id}.zip`);
    await mkdir(this.paths.tmp, { recursive: true });
    await mkdir(this.paths.archives, { recursive: true });
    let writer: ZipWriter | null = null;
    try {
      const sources = await collectSources(profile, options.includeSecrets === true);
      writer = new ZipWriter(temporary);
      let completed = 0;
      for (const source of sources) {
        await writer.addFile(source.name, source.path);
        completed += 1;
        options.onProgress?.({ completed, total: sources.length });
      }
      const archive = await writer.finish();
      await rename(temporary, target);
      const manifest: BackupManifest = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        id,
        name: normalizeBackupName(options.name, profile.name, createdAt),
        createdAt,
        profileId: profile.id,
        profileName: profile.name,
        layout: profile.layout,
        sizeBytes: archive.sizeBytes,
        checksumSha256: archive.checksumSha256,
        includesSecrets: options.includeSecrets === true && sources.some((source) => source.name === 'secrets.json'),
        fileCount: sources.length,
        source: 'created',
        fingerprint,
      };
      await this.save([...await this.load(), manifest]);
      this.logger(`[backup] created ${manifest.name} (${manifest.fileCount} files)`);
      return { ...manifest };
    } catch (error) {
      await writer?.abort();
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** Move an uploaded archive into the active profile's durable library. */
  public async importArchive(profile: Profile, archivePath: string, originalName?: string): Promise<{ manifest: BackupManifest; preview: RestorePreview }> {
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    const preview = await this.preview(archivePath, profile.layout);
    const details = await stat(archivePath);
    const target = join(this.paths.archives, `${id}.zip`);
    await mkdir(this.paths.archives, { recursive: true });
    await moveArchive(archivePath, target);
    const manifest: BackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      id,
      name: normalizeBackupName(originalName, profile.name, createdAt),
      createdAt,
      profileId: profile.id,
      profileName: profile.name,
      layout: profile.layout,
      sizeBytes: details.size,
      checksumSha256: await checksumFile(target),
      includesSecrets: preview.includesSecrets,
      fileCount: preview.fileCount,
      source: 'uploaded',
    };
    await this.save([...await this.load(), manifest]);
    this.logger(`[backup] imported ${manifest.name} (${manifest.fileCount} files)`);
    return { manifest: { ...manifest }, preview };
  }

  public async rename(id: string, name: string): Promise<BackupManifest> {
    const manifests = await this.load();
    const current = manifests.find((manifest) => manifest.id === id);
    if (!current) throw new BackupError('backup_not_found', 'Backup not found');
    const next = { ...current, name: normalizeBackupName(name, current.profileName, current.createdAt) };
    await this.save(manifests.map((manifest) => manifest.id === id ? next : manifest));
    this.logger(`[backup] renamed ${current.name} to ${next.name}`);
    return { ...next };
  }

  public async remove(id: string): Promise<void> {
    const manifests = await this.load();
    if (!manifests.some((manifest) => manifest.id === id)) throw new BackupError('backup_not_found', 'Backup not found');
    await rm(join(this.paths.archives, `${id}.zip`), { force: true });
    await this.save(manifests.filter((manifest) => manifest.id !== id));
    this.logger(`[backup] deleted ${id}`);
  }

  public async preview(archivePath: string, fallbackLayout: ProfileLayout = 'data'): Promise<RestorePreview> {
    const entries = await readZipDirectory(archivePath);
    return previewEntries(entries, fallbackLayout);
  }

  public async restore(profile: Profile, archivePath: string, options: RestoreOptions): Promise<RestorePreview> {
    const release = await this.acquireOperation();
    try {
      return await this.restoreUnlocked(profile, archivePath, options);
    } finally {
      release();
    }
  }

  private async restoreUnlocked(profile: Profile, archivePath: string, options: RestoreOptions): Promise<RestorePreview> {
    const entries = await readZipDirectory(archivePath);
    const preview = previewEntries(entries, profile.layout);
    if (preview.includesSecrets && options.allowSecrets !== true) {
      throw new BackupError('secrets_confirmation_required', 'This archive contains secrets.json; confirm that secrets may be restored');
    }
    const dataDestination = await resolveProfileDataRoot(profile);
    // Keep staging on the profile volume. ModelScope's /tmp is a different
    // filesystem, which turns rename into a full byte copy after extraction.
    const stagingRoot = resolve(dataDestination, '..');
    const temporary = join(stagingRoot, `${STAGING_PREFIX}${randomUUID()}`);
    await mkdir(stagingRoot, { recursive: true });
    await this.sweepAbandonedStaging(stagingRoot);
    await mkdir(temporary, { recursive: true });
    try {
      await this.timed(`extracted ${preview.fileCount} files`, () => extractEntries(archivePath, entries, temporary, options.onProgress));
      const configName = entries.some((entry) => entry.name === 'config.yml') ? 'config.yml' : 'config.yaml';
      const hasConfig = entries.some((entry) => entry.name === 'config.yaml' || entry.name === 'config.yml');
      const archiveDataRoot = hasDefaultUserWrapper(entries) ? join(temporary, DEFAULT_USER_HANDLE) : temporary;
      options.onStatus?.('Applying restored data');
      this.logger(`[backup] applying restored data to ${profile.name}`);
      if (options.mode === 'replace') {
        options.onStatus?.('Clearing existing data');
        await this.timed('cleared existing data', async () => {
          await clearDataRoot(dataDestination, dataDestination === resolve(profile.dataPath), preview.includesSecrets, (path) => this.discard(path, stagingRoot));
          if (hasConfig) await rm(profile.configPath, { force: true });
        });
      }
      await mkdir(dataDestination, { recursive: true });
      const excludedDataFiles = new Set([configName, 'secrets.json']);
      options.onStatus?.('Moving restored data into place');
      await this.timed('moved restored data into place', () => moveDataFiles(archiveDataRoot, dataDestination, excludedDataFiles, options.mode === 'merge'));
      const configSource = join(temporary, configName);
      // Staging is discarded either way, so both modes can take the bytes by
      // rename instead of copying the file a second time.
      if (hasConfig && await exists(configSource)) await movePath(configSource, profile.configPath);
      if (preview.includesSecrets && options.allowSecrets === true) {
        const secretsSource = join(archiveDataRoot, 'secrets.json');
        if (await exists(secretsSource)) await movePath(secretsSource, join(dataDestination, 'secrets.json'));
      }
      options.onStatus?.('Finalizing restored data');
      this.logger(`[backup] finalized restored data for ${profile.name}`);
      const targetLabel = profile.layout === 'data' ? relative(resolve(profile.dataPath), dataDestination).replaceAll('\\', '/') || '.' : 'public/';
      this.logger(`[backup] restored ${preview.fileCount} files to ${profile.name}/${targetLabel} (${options.mode})`);
      return preview;
    } finally {
      await this.discard(temporary, stagingRoot);
    }
  }

  /**
   * Take a tree out of the way now and delete it in the background.
   *
   * Deleting 11,000 files on a network volume costs as much as writing them.
   * The operator is waiting for SillyTavern to come back, not for the old
   * copy to be gone, so only the rename is on the critical path. Anything the
   * process does not finish is swept by the next restore.
   */
  private async discard(path: string, trashRoot: string): Promise<void> {
    if (!await exists(path)) return;
    // The trash sits beside the user data directory rather than inside it, so
    // SillyTavern never sees a half-deleted tree among its own folders, and it
    // stays on the same volume so the rename cannot turn into a byte copy.
    const trash = join(trashRoot, `${TRASH_PREFIX}${randomUUID()}`);
    try {
      await rename(path, trash);
    } catch (error: unknown) {
      if (!isCrossDeviceError(error) && !isRetryableRemoveError(error)) throw error;
      // Deleting in place is what this method exists to avoid, so say so
      // rather than letting the operator watch a frozen progress bar.
      this.logger(`[backup] could not set ${path} aside (${isRecord(error) ? String(error.code) : 'unknown'}); deleting it in place, which is slow on a network volume`);
      await this.timed('deleted existing data in place', () => removeTree(path));
      return;
    }
    this.trackCleanup(trash);
  }

  private trackCleanup(path: string): void {
    this.cleanupTail = this.cleanupTail
      .then(() => removeTree(path))
      .catch((error: unknown) => { this.logger(`[backup] deferred cleanup failed for ${path}: ${error instanceof Error ? error.message : 'unknown error'}`); });
  }

  /** Wait for background deletions. Tests and shutdown need a quiet filesystem. */
  public async settle(): Promise<void> {
    await this.cleanupTail;
  }

  /**
   * Run a restore phase and log how long it took.
   *
   * A hosted volume's speed varies by an order of magnitude between runs, so
   * the only way to know which phase to work on next is to measure each one on
   * the machine that is actually slow.
   */
  private async timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      this.logger(`[backup] ${label} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
  }

  /** Remove staging and trash directories a previous run could not finish. */
  private async sweepAbandonedStaging(root: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error: unknown) {
      if (isFileNotFound(error)) return;
      throw error;
    }
    for (const name of names) {
      if (name.startsWith(STAGING_PREFIX) || name.startsWith(TRASH_PREFIX)) this.trackCleanup(join(root, name));
    }
  }

  private async acquireOperation(): Promise<() => void> {
    this.pendingOperations += 1;
    const previous = this.operationTail;
    let releaseQueue!: () => void;
    this.operationTail = new Promise<void>((resolvePromise) => { releaseQueue = resolvePromise; });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingOperations -= 1;
      releaseQueue();
    };
  }

  /** Store an uploaded ZIP outside the archive library until preview/restore finishes. */
  public async saveUpload(stream: AsyncIterable<Uint8Array>): Promise<string> {
    const target = join(this.paths.tmp, `upload-${randomUUID()}.zip`);
    await mkdir(this.paths.tmp, { recursive: true });
    let total = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES) {
          callback(new BackupError('upload_too_large', 'The uploaded ZIP is too large'));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.from(stream), limiter, createWriteStream(target, { mode: 0o600 }));
      return target;
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  /**
   * Append one bounded upload chunk. ModelScope's proxy rejects large single
   * request bodies, so the panel sends a ZIP as a sequence of chunks. State is
   * persisted beside the part file so a manager restart cannot silently join
   * chunks in the wrong order.
   */
  public async appendUploadChunk(uploadId: string, index: number, stream: AsyncIterable<Uint8Array>): Promise<{ index: number; bytes: number; totalBytes: number }> {
    validateUploadId(uploadId);
    if (!Number.isSafeInteger(index) || index < 0) throw new BackupError('invalid_upload_chunk', 'The upload chunk index is invalid');
    const partPath = this.uploadPartPath(uploadId);
    const statePath = this.uploadStatePath(uploadId);
    const current = await this.readUploadState(statePath);
    if (current && index < current.nextIndex) {
      // A proxy may reset after the server committed the chunk but before the
      // browser received the response. Treat that retry as idempotent.
      return { index, bytes: 0, totalBytes: current.bytes };
    }
    if (index === 0) {
      if (current && current.nextIndex !== 0) throw new BackupError('upload_already_started', 'The upload has already started');
      await rm(partPath, { force: true });
    } else if (!current || current.nextIndex !== index) {
      throw new BackupError('invalid_upload_chunk', `Expected upload chunk ${current?.nextIndex ?? 0}`);
    }

    let chunkBytes = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        chunkBytes += chunk.length;
        if (chunkBytes > MAX_UPLOAD_CHUNK_BYTES) {
          callback(new BackupError('upload_chunk_too_large', 'The upload chunk is too large'));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await mkdir(this.paths.tmp, { recursive: true });
      await pipeline(Readable.from(stream), limiter, createWriteStream(partPath, { flags: index === 0 ? 'w' : 'a', mode: 0o600 }));
      const totalBytes = (await stat(partPath)).size;
      if (totalBytes > MAX_UPLOAD_BYTES) throw new BackupError('upload_too_large', 'The uploaded ZIP is too large');
      await this.writeUploadState(statePath, { schemaVersion: 1, nextIndex: index + 1, bytes: totalBytes });
      return { index, bytes: chunkBytes, totalBytes };
    } catch (error) {
      await this.removeUpload(uploadId);
      throw error;
    }
  }

  /** Finish a chunked upload and return its temporary archive path. */
  public async finishUpload(uploadId: string, expectedBytes?: number): Promise<string> {
    validateUploadId(uploadId);
    const partPath = this.uploadPartPath(uploadId);
    const statePath = this.uploadStatePath(uploadId);
    const state = await this.readUploadState(statePath);
    if (!state || state.nextIndex < 1) throw new BackupError('upload_incomplete', 'No upload chunks were received');
    const details = await stat(partPath).catch(() => null);
    if (!details) throw new BackupError('upload_incomplete', 'The uploaded archive is missing');
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes !== details.size)) {
      throw new BackupError('upload_incomplete', `The upload is incomplete: received ${details.size} bytes`);
    }
    await rm(statePath, { force: true });
    return partPath;
  }

  /** Remove an interrupted chunked upload. */
  public async removeUpload(uploadId: string): Promise<void> {
    validateUploadId(uploadId);
    await Promise.all([
      rm(this.uploadPartPath(uploadId), { force: true }),
      rm(this.uploadStatePath(uploadId), { force: true }),
    ]);
  }

  public async removeTemporary(path: string): Promise<void> {
    const root = resolve(this.paths.tmp);
    const candidate = resolve(path);
    if (!candidate.startsWith(`${root}\\`) && !candidate.startsWith(`${root}/`)) throw new BackupError('invalid_temporary_path', 'The temporary archive path is invalid');
    await rm(candidate, { force: true, recursive: true });
  }

  private uploadPartPath(uploadId: string): string { return join(this.paths.tmp, `upload-${uploadId}.zip.part`); }

  private uploadStatePath(uploadId: string): string { return join(this.paths.tmp, `upload-${uploadId}.json`); }

  private async readUploadState(path: string): Promise<UploadState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(parsed)) throw new Error('invalid upload state');
      const nextIndex = parsed.nextIndex;
      const bytes = parsed.bytes;
      if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(nextIndex) || (nextIndex as number) < 0 || !Number.isSafeInteger(bytes) || (bytes as number) < 0) throw new Error('invalid upload state');
      return { schemaVersion: 1, nextIndex: nextIndex as number, bytes: bytes as number };
    } catch (error: unknown) {
      if (isFileNotFound(error)) return null;
      throw new BackupError('invalid_upload_state', 'The upload state is invalid; start the upload again');
    }
  }

  private async writeUploadState(path: string, state: UploadState): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  private async load(): Promise<BackupManifest[]> {
    if (this.manifests) return this.manifests;
    await mkdir(this.paths.state, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, BACKUP_STATE_FILE), 'utf8'));
      if (!isRecord(parsed) || parsed.schemaVersion !== BACKUP_SCHEMA_VERSION || !Array.isArray(parsed.backups)) throw new Error('Invalid backup state');
      this.manifests = parsed.backups.map(parseManifest);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      this.manifests = [];
    }
    return this.manifests;
  }

  private async save(backups: BackupManifest[]): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, BACKUP_STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      const payload: PersistedBackups = { schemaVersion: BACKUP_SCHEMA_VERSION, backups };
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.manifests = backups;
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }
}

export class BackupError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class ZipWriter {
  private readonly output: ReturnType<typeof createWriteStream>;
  private readonly checksum = createHash('sha256');
  private readonly central: Array<{ name: Buffer; crc: number; compressedSize: number; uncompressedSize: number; offset: number }> = [];
  private offset = 0;

  public constructor(private readonly path: string) {
    this.output = createWriteStream(path, { mode: 0o600 });
  }

  public async addFile(name: string, path: string): Promise<void> {
    const nameBuffer = Buffer.from(name, 'utf8');
    if (nameBuffer.length > 0xffff) throw new BackupError('invalid_filename', `Archive filename is too long: ${name}`);
    const offset = this.offset;
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    await this.write(local);
    const crcTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        crcTransformState.crc = crc32(chunk, crcTransformState.crc);
        crcTransformState.size += chunk.length;
        callback(null, chunk);
      },
    });
    const crcTransformState = { crc: 0, size: 0 };
    const source = createReadStream(path);
    const compressed = source.pipe(crcTransform).pipe(createDeflateRaw());
    try {
      for await (const chunk of compressed) await this.write(Buffer.from(chunk));
    } catch (error) {
      source.destroy();
      throw error;
    }
    const compressedSize = this.offset - (offset + local.length);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crcTransformState.crc >>> 0, 4);
    descriptor.writeUInt32LE(compressedSize >>> 0, 8);
    descriptor.writeUInt32LE(crcTransformState.size >>> 0, 12);
    await this.write(descriptor);
    this.central.push({ name: nameBuffer, crc: crcTransformState.crc >>> 0, compressedSize, uncompressedSize: crcTransformState.size, offset });
  }

  public async finish(): Promise<{ sizeBytes: number; checksumSha256: string }> {
    const centralOffset = this.offset;
    for (const entry of this.central) {
      const header = Buffer.alloc(46 + entry.name.length);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt16LE(0, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize >>> 0, 20);
      header.writeUInt32LE(entry.uncompressedSize >>> 0, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset >>> 0, 42);
      entry.name.copy(header, 46);
      await this.write(header);
    }
    const centralSize = this.offset - centralOffset;
    if (this.central.length > 0xffff || centralOffset > 0xffffffff || centralSize > 0xffffffff) throw new BackupError('archive_too_large', 'ZIP64 archives are not supported for this backup');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.output.end();
    await finished(this.output);
    return { sizeBytes: this.offset, checksumSha256: this.checksum.digest('hex') };
  }

  public async abort(): Promise<void> {
    this.output.destroy();
    await finished(this.output).catch(() => undefined);
  }

  private async write(chunk: Buffer): Promise<void> {
    this.checksum.update(chunk);
    this.offset += chunk.length;
    if (!this.output.write(chunk)) await onceDrain(this.output);
  }
}

async function collectSources(profile: Profile, includeSecrets: boolean): Promise<ArchiveSource[]> {
  const dataRoot = await resolveProfileDataRoot(profile);
  const sources = await collectTree(dataRoot, dataRoot);
  const names = new Set(sources.map((source) => source.name));
  if (await exists(profile.configPath)) {
    const configName = profile.configPath.toLowerCase().endsWith('.yml') ? 'config.yml' : 'config.yaml';
    if (!names.has(configName)) sources.push({ name: configName, path: profile.configPath });
  }
  const secretsPath = join(dataRoot, 'secrets.json');
  if (includeSecrets && await exists(secretsPath)) sources.push({ name: 'secrets.json', path: secretsPath });
  return sources;
}

async function collectTree(root: string, current: string): Promise<ArchiveSource[]> {
  if (!await exists(current)) return [];
  const details = await lstat(current);
  if (details.isSymbolicLink()) throw new BackupError('linked_path', `Linked data path is not allowed: ${current}`);
  if (!details.isDirectory()) return [{ name: relative(root, current).replaceAll('\\', '/'), path: current }];
  const result: ArchiveSource[] = [];
  for (const child of await readdir(current)) {
    if (EXCLUDED_NAMES.has(child)) continue;
    result.push(...await collectTree(root, join(current, child)));
  }
  return result;
}

function previewEntries(entries: ZipEntry[], fallbackLayout: ProfileLayout): RestorePreview {
  const files: BackupFilePreview[] = [];
  const topNames = new Set<string>();
  let includesSecrets = false;
  let totalBytes = 0;
  for (const entry of entries) {
    validateArchiveEntryName(entry.name);
    if (entry.symlink) throw new BackupError('unsafe_archive', `Symlink entry is not allowed: ${entry.name}`);
    if (entry.directory) continue;
    files.push({ name: entry.name, sizeBytes: entry.uncompressedSize });
    totalBytes += entry.uncompressedSize;
    topNames.add(entry.name.split('/')[0] ?? '');
    if (entry.name === 'secrets.json' || entry.name === `${DEFAULT_USER_HANDLE}/secrets.json`) includesSecrets = true;
  }
  const hasRecognized = [...topNames].some((name) => RECOGNIZED_DATA_NAMES.has(name));
  const warnings = includesSecrets ? ['This archive contains secrets.json. Restoring it can expose provider credentials.'] : [];
  if (!hasRecognized && files.length > 0) warnings.push('The archive does not contain common SillyTavern data markers; review the preview before restoring.');
  return { layout: fallbackLayout, fileCount: files.length, totalBytes, includesSecrets, files, warnings };
}

async function extractEntries(zipPath: string, entries: ZipEntry[], destination: string, onProgress?: (progress: { completed: number; total: number }) => void): Promise<void> {
  // Validate and resolve every path up front so the parallel phase below only
  // does I/O, and a hostile archive is rejected before anything is written.
  const written = new Set<string>();
  const planned: Array<{ entry: ZipEntry; target: string }> = [];
  const parents = new Set<string>();
  for (const entry of entries) {
    if (entry.directory) continue;
    validateArchiveEntryName(entry.name);
    const target = safePath(destination, entry.name);
    if (written.has(target)) throw new BackupError('unsafe_archive', `Duplicate archive entry: ${entry.name}`);
    written.add(target);
    parents.add(resolve(target, '..'));
    planned.push({ entry, target });
  }
  const total = planned.length;
  const concurrency = Math.max(1, Math.min(ioConcurrency(), total));
  await runPooled([...parents], concurrency, async (parent) => { await mkdir(parent, { recursive: true }); });
  // One handle per worker. Reads are positional, so the workers never disturb
  // each other's position, and opening the archive once per worker beats
  // opening a multi-gigabyte file once per entry.
  const handles = await Promise.all(Array.from({ length: concurrency }, () => open(zipPath, 'r')));
  let completed = 0;
  try {
    await runPooled(planned, concurrency, async (item, slot) => {
      await extractEntry(handles[slot]!, item.entry, item.target);
      completed += 1;
      // Updating the in-memory job for every tiny preset makes a remote
      // filesystem restore slower without giving the operator more useful
      // information. Keep the visible counter responsive while batching the
      // progress updates like the SillyTavern backup tool does.
      if (completed === total || completed % 25 === 0) onProgress?.({ completed, total });
    });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

async function extractEntry(archive: FileHandle, entry: ZipEntry, target: string): Promise<void> {
  const local = Buffer.alloc(30);
  await readAt(archive, local, entry.localOffset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new BackupError('invalid_archive', 'The ZIP local header is corrupt');
  const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0) throw new BackupError('invalid_archive', `Archive entry size mismatch: ${entry.name}`);
    await writeFile(target, Buffer.alloc(0), { mode: 0o600 });
    return;
  }
  const source = createReadStream(null as unknown as string, { fd: archive.fd, autoClose: false, start: dataOffset, end: dataOffset + entry.compressedSize - 1 });
  const destination = createWriteStream(target, { mode: 0o600 });
  const counter = new ByteCounter();
  if (entry.compression === 0) await pipeline(source, counter, destination);
  else if (entry.compression === 8) await pipeline(source, createInflateRaw(), counter, destination);
  else {
    source.destroy();
    destination.destroy();
    throw new BackupError('unsupported_archive', `ZIP compression ${entry.compression} is not supported`);
  }
  if (counter.bytes !== entry.uncompressedSize) throw new BackupError('invalid_archive', `Archive entry size mismatch: ${entry.name}`);
}

class ByteCounter extends Transform {
  public bytes = 0;

  public constructor() {
    super({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.bytes += chunk.length;
        callback(null, chunk);
      },
    });
  }
}

async function readAt(archive: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await archive.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) throw new BackupError('invalid_archive', 'The ZIP local header is truncated');
    offset += result.bytesRead;
  }
}

async function readZipDirectory(zipPath: string): Promise<ZipEntry[]> {
  const details = await stat(zipPath);
  const tailLength = Math.min(details.size, 65_557);
  const handle = await open(zipPath, 'r');
  try {
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tail.length, details.size - tail.length);
    const eocdOffset = findSignature(tail, 0x06054b50);
    if (eocdOffset < 0) throw new BackupError('invalid_archive', 'The uploaded file is not a ZIP archive');
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const directorySize = tail.readUInt32LE(eocdOffset + 12);
    const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize > MAX_ZIP_DIRECTORY_BYTES) throw new BackupError('archive_too_large', 'ZIP64 archives are not supported for this backup');
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directory.length, directoryOffset);
    const entries: ZipEntry[] = [];
    let offset = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new BackupError('invalid_archive', 'The ZIP central directory is corrupt');
      const flags = directory.readUInt16LE(offset + 8);
      const compression = directory.readUInt16LE(offset + 10);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const localOffset = directory.readUInt32LE(offset + 42);
      if (offset + 46 + nameLength + extraLength + commentLength > directory.length) throw new BackupError('invalid_archive', 'The ZIP central directory is corrupt');
      const name = directory.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'utf8').replaceAll('\\', '/');
      const externalAttributes = directory.readUInt32LE(offset + 38);
      entries.push({ name, compressedSize, uncompressedSize, compression, localOffset, directory: name.endsWith('/') || (externalAttributes & 0x10) !== 0, symlink: ((externalAttributes >>> 16) & 0xf000) === 0xa000 });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function validateArchiveEntryName(name: string): void {
  const normalized = name.replaceAll('\\', '/');
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').includes('..')) throw new BackupError('unsafe_archive', `Unsafe archive path: ${name}`);
}

function safePath(root: string, name: string): string {
  const candidate = resolve(root, ...name.replaceAll('\\', '/').split('/').filter((piece) => piece.length > 0 && piece !== '.'));
  const rootResolved = resolve(root);
  const relativeCandidate = relative(rootResolved, candidate);
  if (relativeCandidate.startsWith('..') || relativeCandidate.split(/[\\/]/u).includes('..')) throw new BackupError('unsafe_archive', `Archive path escapes destination: ${name}`);
  return candidate;
}

/**
 * Move extracted files into place without copying their bytes a second time.
 *
 * A replace restore has an empty destination, so whole top-level directories
 * move with one rename each. A merge restore has to descend far enough to keep
 * the files the archive does not mention, and then renames the leaves - which
 * is still far cheaper than reading and rewriting every byte.
 */
async function moveDataFiles(sourceRoot: string, destinationRoot: string, excluded: Set<string>, merge: boolean): Promise<void> {
  const children = (await readdir(sourceRoot)).filter((child) => !excluded.has(child));
  if (!merge) {
    for (const child of children) await movePath(join(sourceRoot, child), join(destinationRoot, child));
    return;
  }
  const directories: string[] = [];
  const files: Array<{ source: string; destination: string }> = [];
  const plan = async (source: string, destination: string): Promise<void> => {
    const details = await lstat(source);
    if (details.isSymbolicLink()) throw new BackupError('unsafe_archive', `Symlink is not allowed: ${source}`);
    if (!details.isDirectory()) { files.push({ source, destination }); return; }
    if (!await isDirectory(destination)) { files.push({ source, destination }); return; }
    directories.push(destination);
    for (const child of await readdir(source)) await plan(join(source, child), join(destination, child));
  };
  for (const child of children) await plan(join(sourceRoot, child), join(destinationRoot, child));
  const concurrency = ioConcurrency();
  await runPooled(directories, concurrency, async (directory) => { await mkdir(directory, { recursive: true }); });
  await runPooled(files, concurrency, async (item) => { await movePath(item.source, item.destination); });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error: unknown) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(resolve(destination, '..'), { recursive: true });
  try {
    await rename(source, destination);
    return;
  } catch (error: unknown) {
    if (isCrossDeviceError(error)) {
      await copyPath(source, destination);
      await removeTree(source);
      return;
    }
    // A merge can land a directory where a file used to be, or the reverse.
    // The archive wins, so clear the obstruction and retry once.
    if (!isReplaceConflictError(error)) throw error;
  }
  await removeTree(destination);
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if (!isCrossDeviceError(error)) throw error;
    await copyPath(source, destination);
    await removeTree(source);
  }
}

async function resolveProfileDataRoot(profile: Profile): Promise<string> {
  if (profile.layout !== 'data') return resolve(profile.dataPath);
  const defaultUserRoot = join(resolve(profile.dataPath), DEFAULT_USER_HANDLE);
  if (await exists(defaultUserRoot)) return defaultUserRoot;
  const legacyMarkers = ['settings.json', 'characters', 'chats', 'worlds', 'groups'];
  if ((await Promise.all(legacyMarkers.map((name) => exists(join(profile.dataPath, name)))).then((items) => items.some(Boolean)))) return resolve(profile.dataPath);
  return defaultUserRoot;
}

async function clearDataRoot(root: string, isDataRoot: boolean, includesSecrets: boolean, discard: (path: string) => Promise<void>): Promise<void> {
  if (!await exists(root)) return;
  if (!isDataRoot) {
    await discard(root);
    return;
  }
  for (const child of await readdir(root)) {
    if (PRESERVED_DATA_ROOT_NAMES.has(child) || PRESERVED_EXCLUDED_NAMES.has(child) && (child !== 'secrets.json' || !includesSecrets)) continue;
    if (child.startsWith(STAGING_PREFIX) || child.startsWith(TRASH_PREFIX)) continue;
    await discard(join(root, child));
  }
}

function hasDefaultUserWrapper(entries: ZipEntry[]): boolean {
  const files = entries.filter((entry) => !entry.directory).map((entry) => entry.name);
  return files.length > 0 && files.every((name) => name.startsWith(`${DEFAULT_USER_HANDLE}/`));
}

async function copyPath(source: string, destination: string): Promise<void> {
  const details = await lstat(source);
  if (details.isSymbolicLink()) throw new BackupError('unsafe_archive', `Symlink is not allowed: ${source}`);
  if (details.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const child of await readdir(source)) await copyPath(join(source, child), join(destination, child));
    return;
  }
  await copyFile(source, destination);
}

async function copyFile(source: string, destination: string): Promise<void> {
  await mkdir(resolve(destination, '..'), { recursive: true });
  await pipeline(createReadStream(source), createWriteStream(destination, { mode: 0o600 }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    return isFileNotFound(error) ? false : Promise.reject(error);
  }
}

/** ModelScope's persistent volume can report ENOTEMPTY while a recursive delete is settling. */
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
      return;
    } catch (error: unknown) {
      if (!isRetryableRemoveError(error) || attempt === 7) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (attempt + 1)));
    }
  }
}

function normalizeBackupName(value: string | undefined, profileName: string, createdAt: string): string {
  const base = (value?.trim() || `${profileName}-${createdAt.slice(0, 19).replaceAll(/[:T]/gu, '-')}`).replaceAll(/[\\/:*?"<>|]/gu, '-').slice(0, 120);
  return base.endsWith('.zip') ? base : `${base}.zip`;
}

async function checksumFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function parseManifest(value: unknown): BackupManifest {
  if (!isRecord(value) || value.schemaVersion !== BACKUP_SCHEMA_VERSION || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.createdAt !== 'string' || typeof value.profileId !== 'string' || typeof value.profileName !== 'string' || (value.layout !== 'data' && value.layout !== 'public') || typeof value.sizeBytes !== 'number' || typeof value.checksumSha256 !== 'string' || typeof value.includesSecrets !== 'boolean' || typeof value.fileCount !== 'number') throw new Error('Invalid backup manifest');
  const source: BackupSource = value.source === 'uploaded' ? 'uploaded' : 'created';
  return { ...value, source } as unknown as BackupManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isFileNotFound(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT'; }
function isCrossDeviceError(error: unknown): boolean { return isRecord(error) && error.code === 'EXDEV'; }
function isRetryableRemoveError(error: unknown): boolean { return isRecord(error) && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(String(error.code)); }
function isReplaceConflictError(error: unknown): boolean { return isRecord(error) && ['EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(String(error.code)); }
function findSignature(buffer: Buffer, signature: number): number { for (let index = buffer.length - 4; index >= 0; index -= 1) if (buffer.readUInt32LE(index) === signature) return index; return -1; }
function validateUploadId(value: string): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(value)) throw new BackupError('invalid_upload_id', 'The upload id is invalid');
}

async function moveArchive(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== 'EXDEV') throw error;
    await pipeline(createReadStream(source), createWriteStream(target, { mode: 0o600 }));
    await rm(source, { force: true });
  }
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    stream.once('drain', resolvePromise);
    stream.once('error', reject);
  });
}
