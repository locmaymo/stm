import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDeflateRaw, createInflateRaw, crc32 } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { pipeline } from 'node:stream/promises';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { BACKUP_KINDS, backupKind, defaultBackupName, logEvent, logLineText, type BackupFilePreview, type BackupKind, type BackupManifest, type BackupSource, type LogEvent, type LogSink, type Profile, type ProfileLayout, type RestoreMode, type RestorePreview, type LocalBackupSchedule } from '../../contracts/src/index.js';
import { createIoLimiter, ioConcurrency, runPooled } from '../../platform/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const BACKUP_STATE_FILE = 'backups.json';
const BACKUP_SCHEMA_VERSION = 1 as const;
/**
 * Half an hour: short enough that a lost evening of chat is at most thirty
 * minutes of it, long enough that a full archive of a large profile is not
 * rewritten while the last one is still being written. The frequent copy is
 * R2's job, which sends only what changed.
 */
const DEFAULT_LOCAL_INTERVAL_MINUTES = 30;
const MAX_LOCAL_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_ZIP_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;
const DEFAULT_USER_HANDLE = 'default-user';
/**
 * Names SillyTavern owns inside the user directory rather than the operator.
 *
 * A backup carries the whole user directory, so these are the only things a
 * replace leaves alone: deleting a running instance's upload scratch or its
 * cookie secret breaks the process rather than restoring anything.
 */
const PRESERVED_DATA_ROOT_NAMES = new Set(['_storage', '_cache', '_uploads', '_webpack', 'cookie-secret.txt']);
const RECOGNIZED_DATA_NAMES = new Set(['settings.json', 'characters', 'chats', 'worlds', 'groups', 'movingUI']);
const OVERWRITE_ATTEMPTS = 4;
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_LOCAL_RETENTION = 1;
/**
 * How long a safety copy outlives the change it guarded, once there is a
 * newer backup to fall back on. A week is long enough to notice that a
 * restore brought back the wrong thing.
 */
const SAFETY_COPY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOCAL_RETENTION = 50;
const STAGING_PREFIX = '.stm-restore-';
const TRASH_PREFIX = '.stm-trash-';

export interface BackupStoreOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  readonly logger?: LogSink;
}

export interface CreateBackupOptions {
  readonly name?: string;
  /** Why it is being written; a manual backup unless said otherwise. */
  readonly kind?: 'manual' | 'scheduled' | 'before-restore' | 'before-switch';
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
  /** Aborted when the operator stops the operation from the panel. */
  readonly signal?: AbortSignal;
}

export interface ImportEntry {
  /** The archive-relative name, the same one a backup of this profile would use. */
  readonly name: string;
  readonly body: Readable;
}

export interface ImportEntriesOptions {
  readonly name?: string;
  readonly kind?: 'r2' | 'uploaded';
  /** When what is imported was taken, for its default name. */
  readonly takenAt?: string;
  readonly entries: AsyncIterable<ImportEntry>;
  /** How many entries are coming, so progress can be a fraction rather than a count. */
  readonly total?: number;
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
  readonly signal?: AbortSignal;
}

export interface RestoreOptions {
  readonly mode: RestoreMode;
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
  readonly onStatus?: (step: LogEvent) => void;
  /** Aborted when the operator stops the operation from the panel. */
  readonly signal?: AbortSignal;
}

interface PersistedBackups {
  readonly schemaVersion: 1;
  readonly backups: BackupManifest[];
  /** Absent until somebody chooses one, which reads as the default. */
  readonly schedule?: LocalBackupSchedule;
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

export interface ArchiveSource {
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
  private readonly logger: LogSink;
  private manifests: BackupManifest[] | null = null;
  private scheduleState: LocalBackupSchedule | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();
  private cleanupTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  public constructor(options: BackupStoreOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
  }

  public async list(profileId?: string): Promise<BackupManifest[]> {
    const manifests = await this.load();
    return manifests.filter((manifest) => !profileId || manifest.profileId === profileId).map((manifest) => ({ ...manifest }));
  }

  /** How often the scheduler takes a local backup of the active profile. */
  public async getSchedule(): Promise<LocalBackupSchedule> {
    await this.load();
    return this.scheduleState ? { ...this.scheduleState } : { intervalMinutes: DEFAULT_LOCAL_INTERVAL_MINUTES };
  }

  /** `intervalMinutes: 0` turns the schedule off; backups can still be taken by hand. */
  public async setSchedule(input: LocalBackupSchedule): Promise<LocalBackupSchedule> {
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 0 || input.intervalMinutes > MAX_LOCAL_INTERVAL_MINUTES) {
      throw new BackupError('invalid_backup_schedule', `The local backup interval must be 0 (off) or a whole number of minutes from 1 to ${MAX_LOCAL_INTERVAL_MINUTES}`);
    }
    await this.load();
    this.scheduleState = { intervalMinutes: input.intervalMinutes };
    await this.save();
    return { ...this.scheduleState };
  }

  /**
   * Take the interval an older version kept with the R2 settings.
   *
   * Only when nothing has been chosen here, so handing it over again after an
   * interrupted start can never undo a choice made since. A value that was out
   * of range there is dropped rather than carried.
   */
  public async adoptLegacySchedule(intervalMinutes: number): Promise<void> {
    await this.load();
    // The old setting had no "off", so a zero there was never a choice.
    if (this.scheduleState || intervalMinutes < 1) return;
    try {
      await this.setSchedule({ intervalMinutes });
    } catch (error: unknown) {
      if (!(error instanceof BackupError)) throw error;
    }
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
      const children = await limiter.run(() => readdir(current));
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

  /**
   * Every file an archive of this profile would hold, with where each one is.
   *
   * The incremental R2 backup walks the same tree the ZIP does, so that the two
   * cannot disagree about what a backup of this profile means - the difference
   * between them is what is sent, not what is included.
   */
  public async sources(profile: Profile): Promise<ArchiveSource[]> {
    return await collectSources(profile);
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

  /**
   * Run something that rewrites the profile with the backup slot held.
   *
   * Preparing a legacy runtime rewrites the user directory, and persisting one
   * back deletes and rebuilds it outright. A scheduled backup reading that tree
   * at the same time watched its own file list evaporate under it. Taking the
   * slot backups and restores take means the two cannot overlap in either
   * order, rather than only when the backup happens to start second.
   */
  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireOperation();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Claim the operation slot before the work that needs it starts.
   *
   * A restore stops SillyTavern, reads the archive and only then asks for a
   * safety copy. The scheduler ticks every minute, and in that gap it saw an
   * idle store and started a full backup - which the restore then queued
   * behind. Reserving first closes the gap; the returned function releases it.
   */
  public reserve(): () => void {
    this.pendingOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingOperations -= 1;
    };
  }

  /**
   * Guarantee a recoverable copy of the profile without necessarily writing one.
   *
   * A restore has to be undoable, but if the newest backup still matches the
   * profile byte for byte then it already is that copy, and reading every file
   * again to produce an identical archive is pure cost - on a hosted volume it
   * is minutes of it. Comparing fingerprints is one metadata pass instead.
   */
  public async createSafetyCopy(profile: Profile, options: CreateBackupOptions = {}): Promise<BackupManifest> {
    const release = await this.acquireOperation();
    try {
      const fingerprint = await this.fingerprint(profile);
      const candidate = (await this.load())
        .filter((manifest) => manifest.profileId === profile.id && manifest.source === 'created' && manifest.fingerprint === fingerprint)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (candidate && await this.getArchivePath(candidate.id)) {
        this.logger(logEvent('backup.reusingSafetyCopy', `[backup] reusing ${candidate.name} as the safety copy; the profile has not changed since it was written`, { name: candidate.name }));
        return candidate;
      }
      return await this.createUnlocked(profile, options);
    } finally {
      release();
    }
  }

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
      const sources = await collectSources(profile);
      writer = new ZipWriter(temporary);
      let completed = 0;
      const skipped: string[] = [];
      for (const source of sources) {
        throwIfStopped(options.signal);
        if (!await writer.addFile(source.name, source.path)) skipped.push(source.name);
        completed += 1;
        options.onProgress?.({ completed, total: sources.length });
      }
      if (skipped.length > 0) this.logger(logEvent('backup.skippedMissingFiles', `[backup] skipped ${skipped.length} file(s) removed while the backup was running, starting with ${skipped[0]}`, { count: skipped.length, first: skipped[0] ?? '' }));
      const archive = await writer.finish();
      await rename(temporary, target);
      const manifest: BackupManifest = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        id,
        name: normalizeBackupName(options.name, profile.name, createdAt, options.kind ?? 'manual'),
        createdAt,
        profileId: profile.id,
        profileName: profile.name,
        layout: profile.layout,
        sizeBytes: archive.sizeBytes,
        checksumSha256: archive.checksumSha256,
        fileCount: sources.length - skipped.length,
        kind: options.kind ?? 'manual',
        ...(options.name?.trim() ? {} : { autoNamed: true }),
        source: 'created',
        fingerprint,
      };
      await this.save([...await this.load(), manifest]);
      this.logger(logEvent('backup.created', `[backup] created ${manifest.name} (${manifest.fileCount} files)`, { name: manifest.name, files: manifest.fileCount }));
      await this.pruneCreated(profile.id);
      return { ...manifest };
    } catch (error) {
      await writer?.abort();
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * Drop the archives this manager wrote that a newer one supersedes.
   *
   * The scheduler writes one whenever the data changes and a restore writes
   * another before it touches anything, and nothing removed them - a profile of
   * a couple of gigabytes turned into tens of them inside a day.
   *
   * Each kind is kept by its own rule, because they were all kept by one: the
   * newest archive of any kind survived, so the automatic backup taken half an
   * hour after a backup somebody took on purpose deleted it.
   *
   *   - Manual backups are the operator's, and only the operator removes them.
   *     So are uploads and recovery points brought back from R2.
   *   - Automatic backups keep the newest `STM_LOCAL_BACKUPS` (one by default).
   *   - Safety copies - before a restore, before a profile switch - keep the
   *     newest one, the undo for the last such change, and even that goes once
   *     it is a week old and a newer backup exists to fall back on.
   */
  public async pruneCreated(profileId: string): Promise<number> {
    const manifests = await this.load();
    const newestFirst = manifests
      .filter((manifest) => manifest.profileId === profileId && manifest.source === 'created')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const scheduled = newestFirst.filter((manifest) => backupKind(manifest) === 'scheduled');
    const safety = newestFirst.filter((manifest) => { const kind = backupKind(manifest); return kind === 'before-restore' || kind === 'before-switch'; });
    const now = this.now().getTime();
    const expired = safety.filter((manifest, index) => {
      if (index > 0) return true;
      const newer = newestFirst.some((other) => other.createdAt > manifest.createdAt);
      return newer && now - Date.parse(manifest.createdAt) > SAFETY_COPY_MAX_AGE_MS;
    });
    const superseded = [...scheduled.slice(localRetention()), ...expired];
    if (superseded.length === 0) return 0;
    const removed = new Set(superseded.map((manifest) => manifest.id));
    // Leave the library first: an interrupted sweep should leave a stray file,
    // never an entry pointing at an archive that is no longer there.
    await this.save(manifests.filter((manifest) => !removed.has(manifest.id)));
    await runPooled(superseded, ioConcurrency(), async (manifest) => { await rm(join(this.paths.archives, `${manifest.id}.zip`), { force: true }); });
    this.logger(logEvent('backup.removedSuperseded', `[backup] removed ${superseded.length} superseded backup(s)`, { count: superseded.length }));
    return superseded.length;
  }

  /** Move an uploaded archive into the active profile's durable library. */
  public async importArchive(profile: Profile, archivePath: string, originalName?: string, options: { readonly kind?: 'r2' | 'uploaded'; readonly takenAt?: string } = {}): Promise<{ manifest: BackupManifest; preview: RestorePreview }> {
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
      name: normalizeBackupName(originalName, profile.name, options.takenAt ?? createdAt, options.kind === 'r2' ? 'r2' : 'manual'),
      createdAt,
      profileId: profile.id,
      profileName: profile.name,
      layout: profile.layout,
      sizeBytes: details.size,
      checksumSha256: await checksumFile(target),
      fileCount: preview.fileCount,
      source: 'uploaded',
      kind: options.kind ?? 'uploaded',
      ...(options.kind === 'r2' && !originalName?.trim() ? { autoNamed: true } : {}),
    };
    await this.save([...await this.load(), manifest]);
    this.logger(logEvent('backup.imported', `[backup] imported ${manifest.name} (${manifest.fileCount} files)`, { name: manifest.name, files: manifest.fileCount }));
    return { manifest: { ...manifest }, preview };
  }

  /**
   * Build an archive out of content that is not on this disk, and shelve it.
   *
   * A recovery point pulled back from R2 lands in the same library as anything
   * else, so restoring it is the path that already exists: the same validation,
   * the same preview, the same safety snapshot, the same merge-or-replace
   * choice. Nothing about restoring has to know where an archive came from.
   */
  public async importFromEntries(profile: Profile, options: ImportEntriesOptions): Promise<{ manifest: BackupManifest; preview: RestorePreview }> {
    await mkdir(this.paths.tmp, { recursive: true });
    // Beside its final target, because /tmp is often a different filesystem
    // from the persistent volume and the move would fail with EXDEV.
    await mkdir(this.paths.archives, { recursive: true });
    const temporary = join(this.paths.archives, `.${randomUUID()}.zip.tmp`);
    let writer: ZipWriter | null = null;
    try {
      writer = new ZipWriter(temporary);
      let completed = 0;
      for await (const entry of options.entries) {
        throwIfStopped(options.signal);
        await writer.addStream(entry.name, entry.body);
        completed += 1;
        options.onProgress?.({ completed, total: options.total ?? completed });
      }
      await writer.finish();
      writer = null;
      return await this.importArchive(profile, temporary, options.name, { ...(options.kind ? { kind: options.kind } : {}), ...(options.takenAt ? { takenAt: options.takenAt } : {}) });
    } catch (error) {
      await writer?.abort();
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * Call a safety copy what it turned out to be: an ordinary automatic backup.
   *
   * A restore that stopped before writing anything, or that was put back after
   * being stopped, leaves the profile exactly as its safety copy holds it. The
   * copy then guards nothing, and left as a safety copy it would sit in the
   * library beside the automatic backups that follow. As an automatic backup
   * it is the newest one, and the next one supersedes it.
   */
  public async reclassifyAsScheduled(id: string): Promise<void> {
    const manifests = await this.load();
    const current = manifests.find((manifest) => manifest.id === id);
    if (!current || current.source !== 'created') return;
    const kind = backupKind(current);
    if (kind !== 'before-restore' && kind !== 'before-switch') return;
    const next: BackupManifest = { ...current, kind: 'scheduled', ...(current.autoNamed ? { name: normalizeBackupName(undefined, current.profileName, current.createdAt, 'scheduled') } : {}) };
    await this.save(manifests.map((manifest) => manifest.id === id ? next : manifest));
    await this.pruneCreated(current.profileId);
  }

  public async rename(id: string, name: string): Promise<BackupManifest> {
    const manifests = await this.load();
    const current = manifests.find((manifest) => manifest.id === id);
    if (!current) throw new BackupError('backup_not_found', 'Backup not found');
    const { autoNamed: _auto, ...named } = current;
    const next = { ...named, name: normalizeBackupName(name, current.profileName, current.createdAt, 'manual') };
    await this.save(manifests.map((manifest) => manifest.id === id ? next : manifest));
    this.logger(logEvent('backup.renamed', `[backup] renamed ${current.name} to ${next.name}`, { from: current.name, to: next.name }));
    return { ...next };
  }

  public async remove(id: string): Promise<void> {
    const manifests = await this.load();
    if (!manifests.some((manifest) => manifest.id === id)) throw new BackupError('backup_not_found', 'Backup not found');
    await rm(join(this.paths.archives, `${id}.zip`), { force: true });
    await this.save(manifests.filter((manifest) => manifest.id !== id));
    this.logger(logEvent('backup.deleted', `[backup] deleted ${id}`, { id }));
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

  /**
   * Write the archive straight into the profile.
   *
   * An earlier version extracted into a staging directory and then renamed the
   * result into place, on the assumption that rename is a metadata operation.
   * On a ModelScope studio it is not: renaming a directory of 9,000 files on
   * /mnt/workspace measured 757 seconds, the same order as copying it. Staging
   * therefore cost a second full pass over the data and bought nothing, so
   * entries now go to their final path on the first and only pass.
   *
   * A replace no longer clears the profile first either. Most of the paths in
   * the archive are paths the profile already has, and overwriting them is one
   * operation where deleting and rewriting is two. Only the files the archive
   * does not mention have to be removed, and that set is normally small.
   */
  private async restoreUnlocked(profile: Profile, archivePath: string, options: RestoreOptions): Promise<RestorePreview> {
    throwIfStopped(options.signal);
    const entries = await readZipDirectory(archivePath);
    const preview = previewEntries(entries, profile.layout);
    const dataDestination = await resolveProfileDataRoot(profile);
    const plan = planEntries(entries, { dataDestination, configPath: resolve(profile.configPath) });
    const keep = new Set(plan.map((item) => item.target));
    // Read the profile's current contents before writing, so a replace knows
    // which of its files the archive is not going to overwrite.
    const obsolete = options.mode === 'replace'
      ? await this.timed(logEvent('backup.phaseListedObsolete', 'listed files the backup does not contain'), () => collectObsolete(dataDestination, dataDestination === resolve(profile.dataPath), keep))
      : [];
    await mkdir(dataDestination, { recursive: true });
    // Staging directories from older versions are pure waste now; sweep any the
    // upgrade left behind rather than leaving them to confuse SillyTavern.
    await this.sweepAbandonedStaging(resolve(dataDestination, '..'));
    options.onStatus?.(logEvent('restore.restoringFiles', 'Restoring files'));
    this.logger(logEvent('backup.restoring', `[backup] restoring ${plan.length} files into ${dataDestination}`, { count: plan.length, path: dataDestination }));
    await this.timed(logEvent('backup.phaseWroteFiles', `wrote ${plan.length} files`, { count: plan.length }), () => extractPlan(archivePath, plan, options.onProgress, options.signal));
    if (obsolete.length > 0) {
      options.onStatus?.(logEvent('restore.removingObsolete', 'Removing files the backup does not contain'));
      await this.timed(logEvent('backup.phaseRemovedObsolete', `removed ${obsolete.length} files the backup does not contain`, { count: obsolete.length }), () => removeAll(obsolete));
    }
    options.onStatus?.(logEvent('restore.finalizing', 'Finalizing restored data'));
    const targetLabel = profile.layout === 'data' ? relative(resolve(profile.dataPath), dataDestination).replaceAll('\\', '/') || '.' : 'public/';
    this.logger(logEvent('backup.restored', `[backup] restored ${preview.fileCount} files to ${profile.name}/${targetLabel} (${options.mode})`, { count: preview.fileCount, profile: profile.name, target: targetLabel, mode: options.mode }));
    return preview;
  }

  private trackCleanup(path: string): void {
    this.cleanupTail = this.cleanupTail
      .then(() => removeTree(path))
      .catch((error: unknown) => { const reason = error instanceof Error ? error.message : 'unknown error'; this.logger(logEvent('backup.deferredCleanupFailed', `[backup] deferred cleanup failed for ${path}: ${reason}`, { path, reason })); });
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
  private async timed<T>(phase: LogEvent, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.logger(logEvent(phase.code, `[backup] ${phase.message} in ${seconds}s`, { ...phase.params, seconds }));
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

  /**
   * Drop chunked uploads nothing is going to finish.
   *
   * Chunks live on the server, not in the browser, so closing the tab mid
   * upload leaves a part file behind and takes the only copy of its upload id
   * with it. Those parts are gigabytes each, so they are swept by age at
   * startup rather than waiting for a tmp directory to be cleared.
   */
  public async sweepStaleUploads(maxAgeMs: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.paths.tmp);
    } catch (error: unknown) {
      if (isFileNotFound(error)) return 0;
      throw error;
    }
    const cutoff = this.now().getTime() - maxAgeMs;
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith('upload-') || (!name.endsWith('.zip.part') && !name.endsWith('.json'))) continue;
      const path = join(this.paths.tmp, name);
      try {
        if ((await stat(path)).mtimeMs > cutoff) continue;
        await rm(path, { force: true });
        removed += 1;
      } catch {
        // A file that vanished under us needed no sweeping.
      }
    }
    if (removed > 0) this.logger(logEvent('backup.removedAbandonedUploads', `[backup] removed ${removed} abandoned upload file(s)`, { count: removed }));
    return removed;
  }

  /**
   * Drop archives in the library that nothing points at.
   *
   * A backup writes `.<id>.zip.tmp` and renames it into place, and an import
   * moves the upload in before recording it. Both have an error path that
   * cleans up, but a process that is killed has no error path - and nothing
   * ever looked afterwards. One partial archive here was 1.2 GB.
   *
   * Only safe at startup, before any backup of its own can be in flight.
   */
  public async sweepOrphanArchives(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.paths.archives);
    } catch (error: unknown) {
      if (isFileNotFound(error)) return 0;
      throw error;
    }
    const known = new Set((await this.load()).map((manifest) => `${manifest.id}.zip`));
    const orphans = names.filter((name) => (name.startsWith('.') && name.endsWith('.zip.tmp')) || (name.endsWith('.zip') && !known.has(name)));
    if (orphans.length === 0) return 0;
    await runPooled(orphans, ioConcurrency(), async (name) => { await rm(join(this.paths.archives, name), { force: true }); });
    this.logger(logEvent('backup.removedOrphanArchives', `[backup] removed ${orphans.length} archive(s) an interrupted backup left behind`, { count: orphans.length }));
    return orphans.length;
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
      this.scheduleState = parseSchedule(parsed.schedule);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      this.manifests = [];
    }
    return this.manifests;
  }

  /**
   * Write the library down. Without a list, the one current when the write
   * runs - not when it was asked for - so a schedule change queued behind a
   * backup cannot put back the list from before that backup.
   */
  private async save(backups?: BackupManifest[]): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, BACKUP_STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      const list = backups ?? this.manifests ?? [];
      const payload: PersistedBackups = { schemaVersion: BACKUP_SCHEMA_VERSION, backups: list, ...(this.scheduleState ? { schedule: this.scheduleState } : {}) };
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.manifests = list;
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }
}

/**
 * Stop between files rather than mid-file.
 *
 * A restore writes entries straight into the profile, so stopping leaves it
 * part old and part new - which is exactly what the pre-restore snapshot the
 * caller takes is for. Stopping between whole files at least means no file is
 * left truncated.
 */
function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupError('operation_canceled', 'The operation was stopped');
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

  /**
   * Add one file, or report that there is no longer a file there to add.
   *
   * The list of sources comes from a walk that finished before this runs, and
   * the profile does not hold still: a legacy runtime shutting down deletes and
   * rebuilds the whole user directory, and SillyTavern deletes a character the
   * moment the operator does. Opening the file before the entry's header is
   * written means a name that no longer resolves is skipped with the archive
   * still well formed - writing the header first left one describing bytes that
   * never arrived.
   */
  public async addFile(name: string, path: string): Promise<boolean> {
    const nameBuffer = Buffer.from(name, 'utf8');
    if (nameBuffer.length > 0xffff) throw new BackupError('invalid_filename', `Archive filename is too long: ${name}`);
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error: unknown) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
    try {
      await this.writeEntry(nameBuffer, handle.createReadStream({ autoClose: false }));
    } finally {
      await handle.close().catch(() => undefined);
    }
    return true;
  }

  /**
   * Add one entry whose bytes are not on this disk.
   *
   * A recovery point fetched from R2 arrives as chunks over the network. Giving
   * them a temporary file each, only to read all of them back, would be a
   * second full pass over gigabytes and a second copy of them on the volume.
   */
  public async addStream(name: string, source: Readable): Promise<void> {
    const nameBuffer = Buffer.from(name, 'utf8');
    if (nameBuffer.length > 0xffff) throw new BackupError('invalid_filename', `Archive filename is too long: ${name}`);
    await this.writeEntry(nameBuffer, source);
  }

  private async writeEntry(nameBuffer: Buffer, source: Readable): Promise<void> {
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
    const deflate = createDeflateRaw();
    const compressed = source.pipe(crcTransform).pipe(deflate);
    // pipe does not forward errors. A read that fails would emit on the source
    // with nobody listening, and an unhandled error event ends the process -
    // which is how a file removed mid-backup took the whole manager down.
    source.once('error', (error: Error) => deflate.destroy(error));
    crcTransform.once('error', (error: Error) => deflate.destroy(error));
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

/**
 * Every file in the user directory, plus the manager's config.
 *
 * SillyTavern's own export copies the user directory whole, and so does this.
 * Leaving anything out - caches, credentials, a cloned extension's git objects -
 * makes a restore produce something that is not what was backed up, and the
 * operator running their own instance wants their data back intact.
 */
async function collectSources(profile: Profile): Promise<ArchiveSource[]> {
  const dataRoot = await resolveProfileDataRoot(profile);
  const sources = await collectTree(dataRoot, dataRoot);
  const names = new Set(sources.map((source) => source.name));
  if (await exists(profile.configPath)) {
    const configName = profile.configPath.toLowerCase().endsWith('.yml') ? 'config.yml' : 'config.yaml';
    if (!names.has(configName)) sources.push({ name: configName, path: profile.configPath });
  }
  return sources;
}

async function collectTree(root: string, current: string): Promise<ArchiveSource[]> {
  if (!await exists(current)) return [];
  const details = await lstat(current);
  if (details.isSymbolicLink()) throw new BackupError('linked_path', `Linked data path is not allowed: ${current}`);
  if (!details.isDirectory()) return [{ name: relative(root, current).replaceAll('\\', '/'), path: current }];
  const result: ArchiveSource[] = [];
  for (const child of await readdir(current)) {
    result.push(...await collectTree(root, join(current, child)));
  }
  return result;
}

function previewEntries(entries: ZipEntry[], fallbackLayout: ProfileLayout): RestorePreview {
  const files: BackupFilePreview[] = [];
  const topNames = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    validateArchiveEntryName(entry.name);
    if (entry.symlink) throw new BackupError('unsafe_archive', `Symlink entry is not allowed: ${entry.name}`);
    if (entry.directory) continue;
    files.push({ name: entry.name, sizeBytes: entry.uncompressedSize });
    totalBytes += entry.uncompressedSize;
    topNames.add(entry.name.split('/')[0] ?? '');
  }
  const hasRecognized = [...topNames].some((name) => RECOGNIZED_DATA_NAMES.has(name));
  const warnings = !hasRecognized && files.length > 0
    ? [logEvent('backup.unknownArchive', 'This archive holds none of the folders a SillyTavern profile usually has.')]
    : [];
  return { layout: fallbackLayout, fileCount: files.length, totalBytes, files, warnings };
}

interface PlannedEntry {
  readonly entry: ZipEntry;
  readonly target: string;
}

interface PlanOptions {
  readonly dataDestination: string;
  readonly configPath: string;
}

/**
 * Resolve every archive entry to its final path.
 *
 * Doing this before any I/O means a hostile archive is rejected before a single
 * byte is written, and the write phase below is pure I/O it can run in parallel.
 *
 * Two archive layouts reach here. SillyTavern's own export holds the contents
 * of the user directory at the archive root, optionally beside a manager
 * `config.yaml`. Ours may wrap everything in `default-user/`, and because that
 * wrapper requires every entry to sit under it, such an archive never carries a
 * config at the root.
 */
function planEntries(entries: ZipEntry[], options: PlanOptions): PlannedEntry[] {
  const prefix = hasDefaultUserWrapper(entries) ? `${DEFAULT_USER_HANDLE}/` : '';
  const planned: PlannedEntry[] = [];
  const taken = new Set<string>();
  for (const entry of entries) {
    if (entry.directory) continue;
    validateArchiveEntryName(entry.name);
    const name = entry.name.replaceAll('\\', '/');
    if (prefix && !name.startsWith(prefix)) continue;
    const relative = prefix ? name.slice(prefix.length) : name;
    if (!relative) continue;
    const target = !prefix && (relative === 'config.yaml' || relative === 'config.yml')
      ? options.configPath
      : safePath(options.dataDestination, relative);
    if (taken.has(target)) throw new BackupError('unsafe_archive', `Duplicate archive entry: ${entry.name}`);
    taken.add(target);
    planned.push({ entry, target });
  }
  return planned;
}

async function extractPlan(zipPath: string, planned: readonly PlannedEntry[], onProgress?: (progress: { completed: number; total: number }) => void, signal?: AbortSignal): Promise<void> {
  const parents = new Set<string>();
  for (const item of planned) parents.add(resolve(item.target, '..'));
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
      throwIfStopped(signal);
      await extractEntry(handles[slot]!, item.entry, item.target);
      completed += 1;
      // Updating the in-memory job for every tiny preset makes a remote
      // filesystem restore slower without giving the operator more useful
      // information. Keep the visible counter responsive while batching the
      // progress updates like the SillyTavern backup tool does.
      if (completed === total || completed % 25 === 0) onProgress?.({ completed, total });
    });
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  }
}

/**
 * Write one archive entry, taking the target from a read-only file if it must.
 *
 * Git stores its loose objects read-only, and Windows refuses to open a
 * read-only file for writing at all. A profile holding a git-cloned extension
 * therefore fails on the second restore of an archive whose first restore - on
 * to a tree that did not have those objects yet - succeeded. A scanner that has
 * just seen a newly written file can hold it for the same EPERM, so a cleared
 * attribute is followed by a short wait rather than an immediate give-up.
 */
async function extractEntry(archive: FileHandle, entry: ZipEntry, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeEntry(archive, entry, target);
      return;
    } catch (error: unknown) {
      if (!isPermissionError(error) || attempt === OVERWRITE_ATTEMPTS - 1) throw error;
      await chmod(target, 0o600).catch(() => undefined);
      if (attempt > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 150 * attempt));
    }
  }
}

async function writeEntry(archive: FileHandle, entry: ZipEntry, target: string): Promise<void> {
  const local = Buffer.alloc(30);
  await readAt(archive, local, entry.localOffset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new BackupError('invalid_archive', 'The ZIP local header is corrupt');
  const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0) throw new BackupError('invalid_archive', `Archive entry size mismatch: ${entry.name}`);
    await writeFile(target, Buffer.alloc(0), { mode: 0o600 });
    return;
  }
  const source = readEntry(archive, dataOffset, entry.compressedSize, entry.name);
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

/**
 * Read one entry's bytes through positional reads on the shared archive handle.
 *
 * Handing that descriptor to a read stream makes it the stream's to close.
 * Destroying such a stream closes the descriptor even when it was created with
 * autoClose false, and a pipeline destroys its source whenever the destination
 * fails to open - so one unwritable file cost the worker its archive handle and
 * every entry after it failed with EBADF. Reading by position never transfers
 * ownership, and the workers do not disturb each other's offset either.
 */
function readEntry(archive: FileHandle, start: number, length: number, name: string): Readable {
  let position = start;
  let remaining = length;
  return new Readable({
    highWaterMark: READ_CHUNK_BYTES,
    read(size: number) {
      if (remaining === 0) { this.push(null); return; }
      const buffer = Buffer.allocUnsafe(Math.min(size || READ_CHUNK_BYTES, remaining, READ_CHUNK_BYTES));
      archive.read(buffer, 0, buffer.length, position).then(({ bytesRead }) => {
        if (bytesRead === 0) { this.destroy(new BackupError('invalid_archive', `Archive entry is truncated: ${name}`)); return; }
        position += bytesRead;
        remaining -= bytesRead;
        this.push(buffer.subarray(0, bytesRead));
      }, (error: unknown) => { this.destroy(error instanceof Error ? error : new Error('Archive read failed')); });
    },
  });
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

async function resolveProfileDataRoot(profile: Profile): Promise<string> {
  if (profile.layout !== 'data') return resolve(profile.dataPath);
  const defaultUserRoot = join(resolve(profile.dataPath), DEFAULT_USER_HANDLE);
  if (await exists(defaultUserRoot)) return defaultUserRoot;
  const legacyMarkers = ['settings.json', 'characters', 'chats', 'worlds', 'groups'];
  if ((await Promise.all(legacyMarkers.map((name) => exists(join(profile.dataPath, name)))).then((items) => items.some(Boolean)))) return resolve(profile.dataPath);
  return defaultUserRoot;
}

/**
 * List the profile's files that the archive is not going to overwrite.
 *
 * This is what a replace has to delete, so that the profile ends up holding
 * exactly what the backup held. Only the directories SillyTavern keeps for its
 * own running state are exempt; use merge when the archive is meant to be laid
 * over the current data rather than to become it.
 */
async function collectObsolete(root: string, isDataRoot: boolean, keep: ReadonlySet<string>): Promise<string[]> {
  const obsolete: string[] = [];
  const limiter = createIoLimiter(ioConcurrency());
  const visit = async (current: string, depth: number): Promise<void> => {
    let children;
    try {
      children = await limiter.run(() => readdir(current, { withFileTypes: true }));
    } catch (error: unknown) {
      if (isFileNotFound(error)) return;
      throw error;
    }
    await Promise.all(children.map(async (child) => {
      if (depth === 0 && isPreservedAtRoot(child.name, isDataRoot)) return;
      const full = join(current, child.name);
      if (child.isSymbolicLink()) return;
      if (child.isDirectory()) {
        await visit(full, depth + 1);
        return;
      }
      if (!keep.has(full)) obsolete.push(full);
    }));
  };
  await visit(root, 0);
  return obsolete;
}

function isPreservedAtRoot(name: string, isDataRoot: boolean): boolean {
  if (name.startsWith(STAGING_PREFIX) || name.startsWith(TRASH_PREFIX)) return true;
  return isDataRoot && PRESERVED_DATA_ROOT_NAMES.has(name);
}

async function removeAll(paths: readonly string[]): Promise<void> {
  await runPooled(paths, ioConcurrency(), async (path) => {
    try {
      await rm(path, { force: true });
    } catch (error: unknown) {
      // The same read-only git objects a write trips over also refuse deletion.
      if (!isPermissionError(error)) throw error;
      await chmod(path, 0o600).catch(() => undefined);
      await rm(path, { force: true });
    }
  });
}

function hasDefaultUserWrapper(entries: ZipEntry[]): boolean {
  const files = entries.filter((entry) => !entry.directory).map((entry) => entry.name);
  return files.length > 0 && files.every((name) => name.startsWith(`${DEFAULT_USER_HANDLE}/`));
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

/** A name somebody gave, or the default for its kind, made safe to be a file name. */
function normalizeBackupName(value: string | undefined, profileName: string, createdAt: string, kind: Exclude<BackupKind, 'uploaded'>): string {
  const base = (value?.trim() || defaultBackupName(profileName, kind, new Date(createdAt))).replaceAll(/[\\/:*?"<>|]/gu, '-').slice(0, 120);
  return base.endsWith('.zip') ? base : `${base}.zip`;
}

async function checksumFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function parseManifest(value: unknown): BackupManifest {
  if (!isRecord(value) || value.schemaVersion !== BACKUP_SCHEMA_VERSION || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.createdAt !== 'string' || typeof value.profileId !== 'string' || typeof value.profileName !== 'string' || (value.layout !== 'data' && value.layout !== 'public') || typeof value.sizeBytes !== 'number' || typeof value.checksumSha256 !== 'string' || typeof value.fileCount !== 'number') throw new Error('Invalid backup manifest');
  const source: BackupSource = value.source === 'uploaded' ? 'uploaded' : 'created';
  const kind = typeof value.kind === 'string' && (BACKUP_KINDS as readonly string[]).includes(value.kind) ? value.kind : undefined;
  const { kind: _stored, autoNamed, ...rest } = value;
  return { ...rest, source, ...(kind ? { kind } : {}), ...(autoNamed === true ? { autoNamed: true } : {}) } as unknown as BackupManifest;
}

function parseSchedule(value: unknown): LocalBackupSchedule | null {
  if (!isRecord(value)) return null;
  const minutes = value.intervalMinutes;
  return typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_LOCAL_INTERVAL_MINUTES ? { intervalMinutes: minutes } : null;
}

/** How many manager-written archives a profile keeps. One, unless asked otherwise. */
function localRetention(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.STM_LOCAL_BACKUPS);
  if (Number.isSafeInteger(configured) && configured >= 1 && configured <= MAX_LOCAL_RETENTION) return configured;
  return DEFAULT_LOCAL_RETENTION;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isFileNotFound(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT'; }
function isRetryableRemoveError(error: unknown): boolean { return isRecord(error) && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(String(error.code)); }
function isPermissionError(error: unknown): boolean { return isRecord(error) && ['EPERM', 'EACCES'].includes(String(error.code)); }
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
    // Take both listeners off on the first event. Leaving the error listener
    // behind on every backpressure wait accumulated one per pause, which is
    // what made a long backup warn about eleven error listeners on one stream.
    function onDrain(): void { stream.removeListener('error', onError); resolvePromise(); }
    function onError(error: Error): void { stream.removeListener('drain', onDrain); reject(error); }
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}
