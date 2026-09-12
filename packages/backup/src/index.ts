import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { pipeline } from 'node:stream/promises';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { BackupFilePreview, BackupManifest, BackupSource, Profile, ProfileLayout, RestoreMode, RestorePreview } from '../../contracts/src/index.js';
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
    const visit = async (current: string): Promise<void> => {
      if (!await exists(current)) return;
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new BackupError('linked_path', `Linked data path is not allowed: ${current}`);
      newestMtime = Math.max(newestMtime, details.mtimeMs);
      if (!details.isDirectory()) {
        fileCount += 1;
        totalBytes += details.size;
        return;
      }
      for (const child of await readdir(current)) {
        if (EXCLUDED_NAMES.has(child)) continue;
        await visit(join(current, child));
      }
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
    const entries = await readZipDirectory(archivePath);
    const preview = previewEntries(entries, profile.layout);
    if (preview.includesSecrets && options.allowSecrets !== true) {
      throw new BackupError('secrets_confirmation_required', 'This archive contains secrets.json; confirm that secrets may be restored');
    }
    const temporary = join(this.paths.tmp, `restore-${randomUUID()}`);
    await mkdir(temporary, { recursive: true });
    try {
      await extractEntries(archivePath, entries, temporary, options.onProgress);
      const configName = entries.some((entry) => entry.name === 'config.yml') ? 'config.yml' : 'config.yaml';
      const hasConfig = entries.some((entry) => entry.name === 'config.yaml' || entry.name === 'config.yml');
      const dataDestination = await resolveProfileDataRoot(profile);
      const archiveDataRoot = hasDefaultUserWrapper(entries) ? join(temporary, DEFAULT_USER_HANDLE) : temporary;
      if (options.mode === 'replace') {
        await clearDataRoot(dataDestination, dataDestination === resolve(profile.dataPath), preview.includesSecrets);
        if (hasConfig) await rm(profile.configPath, { force: true });
      }
      await mkdir(dataDestination, { recursive: true });
      await copyDataFiles(archiveDataRoot, dataDestination, new Set([configName, 'secrets.json']));
      const configSource = join(temporary, configName);
      if (hasConfig && await exists(configSource)) await copyFile(configSource, profile.configPath);
      if (preview.includesSecrets && options.allowSecrets === true) {
        const secretsSource = join(archiveDataRoot, 'secrets.json');
        if (await exists(secretsSource)) await copyFile(secretsSource, join(dataDestination, 'secrets.json'));
      }
      const targetLabel = profile.layout === 'data' ? relative(resolve(profile.dataPath), dataDestination).replaceAll('\\', '/') || '.' : 'public/';
      this.logger(`[backup] restored ${preview.fileCount} files to ${profile.name}/${targetLabel} (${options.mode})`);
      return preview;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
  const written = new Set<string>();
  const files = entries.filter((entry) => !entry.directory);
  let completed = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    validateArchiveEntryName(entry.name);
    const target = safePath(destination, entry.name);
    if (written.has(target)) throw new BackupError('unsafe_archive', `Duplicate archive entry: ${entry.name}`);
    written.add(target);
    await mkdir(resolve(target, '..'), { recursive: true });
    await extractEntry(zipPath, entry, target);
    completed += 1;
    onProgress?.({ completed, total: files.length });
  }
}

async function extractEntry(zipPath: string, entry: ZipEntry, target: string): Promise<void> {
  const handle = await open(zipPath, 'r');
  let dataOffset: number;
  try {
    const local = Buffer.alloc(30);
    await handle.read(local, 0, local.length, entry.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new BackupError('invalid_archive', 'The ZIP local header is corrupt');
    dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0) throw new BackupError('invalid_archive', `Archive entry size mismatch: ${entry.name}`);
    await writeFile(target, Buffer.alloc(0), { mode: 0o600 });
    return;
  }
  const source = createReadStream(zipPath, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 });
  const destination = createWriteStream(target, { mode: 0o600 });
  if (entry.compression === 0) await pipeline(source, destination);
  else if (entry.compression === 8) await pipeline(source, createInflateRaw(), destination);
  else throw new BackupError('unsupported_archive', `ZIP compression ${entry.compression} is not supported`);
  const details = await stat(target);
  if (details.size !== entry.uncompressedSize) throw new BackupError('invalid_archive', `Archive entry size mismatch: ${entry.name}`);
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

async function copyDataFiles(sourceRoot: string, destinationRoot: string, excluded: Set<string>): Promise<void> {
  for (const child of await readdir(sourceRoot)) {
    if (excluded.has(child)) continue;
    await copyPath(join(sourceRoot, child), join(destinationRoot, child));
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

async function clearDataRoot(root: string, isDataRoot: boolean, includesSecrets: boolean): Promise<void> {
  if (!await exists(root)) return;
  if (!isDataRoot) {
    await rm(root, { recursive: true, force: true });
    return;
  }
  for (const child of await readdir(root)) {
    if (PRESERVED_DATA_ROOT_NAMES.has(child) || PRESERVED_EXCLUDED_NAMES.has(child) && (child !== 'secrets.json' || !includesSecrets)) continue;
    await rm(join(root, child), { recursive: true, force: true });
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

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer, previous: number): number {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    stream.once('drain', resolvePromise);
    stream.once('error', reject);
  });
}
