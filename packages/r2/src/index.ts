import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes, logEvent, logLineText, type LogSink, type Profile, type R2Config, type R2Object, type R2SnapshotSummary, type R2Usage, type TransferProgress } from '../../contracts/src/index.js';
import { ioConcurrency, runPooled } from '../../platform/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';
import { BlobLedger } from './ledger.js';
import {
  blobKey,
  decodeBlob,
  decodeSnapshot,
  encodeBlob,
  encodeSnapshot,
  referencedHashes,
  shouldCompress,
  snapshotKey,
  type FileChunk,
  type HashedFile,
  type R2Snapshot,
} from './sync.js';

const R2_STATE_FILE = 'r2-config.json';
const R2_LEDGER_FILE = 'r2-blobs.log';
const R2_SCHEMA_VERSION = 2 as const;
const MASKED_SECRET = '********';
const OBJECT_PREFIX = 'sillytavern-manager/';
const BLOB_PREFIX = `${OBJECT_PREFIX}blobs/`;
const SNAPSHOT_PREFIX = `${OBJECT_PREFIX}snapshots/`;
/** One listing page. R2 caps it here too, so asking for more changes nothing. */
const LIST_PAGE_KEYS = 1000;

/**
 * Defaults chosen against what Cloudflare gives away: 10 GB of storage and a
 * million charged writes a month.
 *
 * Storage is the binding constraint, not operations. Sending only changed
 * chunks means a five-minute schedule costs a handful of small writes per run
 * and nothing at all when nothing changed, so the interval is set by how much
 * work is acceptable to lose rather than by what the quota can bear.
 */
const DEFAULTS = {
  localIntervalMinutes: 60,
  hotIntervalMinutes: 5,
  coldIntervalHours: 6,
  reconcileIntervalHours: 24,
  keepRecent: 48,
  keepDaily: 14,
  keepWeekly: 8,
  // Four fifths of what Cloudflare gives away, in the same decimal units it
  // quotes: 10 GB of storage, a million charged writes, ten million reads.
  maxStorageBytes: 8_000_000_000,
  maxWriteOperations: 800_000,
  maxReadOperations: 8_000_000,
} as const;

interface StoredUsage {
  readonly storageBytes: number;
  readonly blobCount: number;
  readonly snapshotCount: number;
  readonly writeOperations: number;
  readonly readOperations: number;
  readonly periodStartedAt: string;
  readonly legacyObjectCount: number;
  readonly legacyBytes: number;
  readonly lastReconciledAt: string | null;
}

interface StoredR2Config {
  readonly schemaVersion: 2;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly bucket: string | null;
  readonly accountId: string | null;
  readonly accessKeyId: string | null;
  readonly secretAccessKey: string | null;
  readonly localIntervalMinutes: number;
  readonly hotIntervalMinutes: number;
  readonly coldIntervalHours: number;
  readonly reconcileIntervalHours: number;
  readonly keepRecent: number;
  readonly keepDaily: number;
  readonly keepWeekly: number;
  readonly maxStorageBytes: number;
  readonly maxWriteOperations: number;
  readonly maxReadOperations: number;
  readonly lastUploadAt: string | null;
  /** The cold tier runs on its own clock, so it is remembered separately. */
  readonly lastColdUploadAt: string | null;
  readonly lastFingerprint: string | null;
  /**
   * The newest recovery point this manager wrote, so the next run does not have
   * to list the bucket to find it.
   *
   * A listing is a charged operation and the frequent run makes one every few
   * minutes for an answer it already knew. It is a cache like the chunk ledger:
   * if it names something the bucket no longer has, the listing is still there
   * to fall back on.
   */
  readonly lastSnapshot: { readonly profileId: string; readonly id: string } | null;
  readonly usage: StoredUsage;
}

export interface R2ManagerOptions {
  readonly paths: PlatformPaths;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly logger?: LogSink;
  readonly fetchImpl?: typeof fetch;
}

export interface R2UpdateInput {
  readonly enabled?: boolean;
  readonly endpoint?: string | null;
  readonly bucket?: string | null;
  readonly accountId?: string | null;
  readonly accessKeyId?: string | null;
  readonly secretAccessKey?: string | null;
  readonly localIntervalMinutes?: number;
  readonly hotIntervalMinutes?: number;
  readonly coldIntervalHours?: number;
  readonly reconcileIntervalHours?: number;
  readonly keepRecent?: number;
  readonly keepDaily?: number;
  readonly keepWeekly?: number;
  readonly maxStorageBytes?: number;
  readonly maxWriteOperations?: number;
  readonly maxReadOperations?: number;
}

/** One file to consider sending, and where its bytes are on this machine. */
export interface SyncSource {
  readonly file: HashedFile;
  readonly path: string;
}

export interface R2SyncInput {
  readonly profile: Profile;
  /** The files walked and hashed this run. */
  readonly sources: readonly SyncSource[];
  /**
   * Files this run did not look at, taken from the previous snapshot unchanged.
   *
   * This is what lets the frequent run touch only chats and settings while every
   * snapshot it writes is still a complete recovery point: the parts it skipped
   * are already in the bucket, so naming them costs nothing.
   */
  readonly carried?: readonly HashedFile[];
  readonly fingerprint: string;
  readonly tier?: 'hot' | 'cold';
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

export interface R2SyncResult {
  readonly snapshot: R2SnapshotSummary;
  readonly fileCount: number;
  readonly uploadedChunks: number;
  readonly uploadedBytes: number;
  readonly reusedChunks: number;
  readonly usage: R2Usage;
}

export interface R2ReconcileResult {
  readonly blobCount: number;
  readonly collectedBlobs: number;
  readonly collectedBytes: number;
  readonly usage: R2Usage;
}

export interface R2ConnectionResult {
  readonly ok: true;
  readonly objectCount: number;
  readonly totalBytes: number;
}

interface R2Credentials {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface S3ObjectRecord {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModified: string | null;
  readonly etag: string | null;
}

export class R2Error extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class R2HttpError extends R2Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super('r2_request_failed', message);
    this.status = status;
  }
}

export class R2Manager {
  readonly paths: PlatformPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly logger: LogSink;
  private readonly fetchImpl: typeof fetch;
  private readonly ledger: BlobLedger;
  private configState: StoredR2Config | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Held for a sync or a reconcile, never both.
   *
   * Collecting unreferenced chunks reads the snapshots to decide what is still
   * wanted. A sync running beside it has uploaded chunks whose snapshot is not
   * written yet, and those would look exactly like garbage.
   */
  private busy: Promise<unknown> = Promise.resolve();
  /**
   * Charged requests made since they were last written down.
   *
   * The count used to live on the client, and every method that made its own
   * client threw its count away with it - which is how listing the bucket, the
   * most expensive thing the panel did, counted as nothing at all. It belongs
   * to the manager, because the manager is what outlives a request.
   */
  private charges = { write: 0, read: 0 };
  private chargesWrittenAt = 0;

  public constructor(options: R2ManagerOptions) {
    this.paths = options.paths;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ledger = new BlobLedger({ path: join(this.paths.state, R2_LEDGER_FILE) });
  }

  public async getConfig(): Promise<R2Config> {
    return this.toPublic(await this.load());
  }

  public async update(input: R2UpdateInput): Promise<R2Config> {
    const current = await this.load();
    const next: StoredR2Config = {
      ...current,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.endpoint !== undefined ? { endpoint: normalizeNullable(input.endpoint) } : {}),
      ...(input.bucket !== undefined ? { bucket: normalizeNullable(input.bucket) } : {}),
      ...(input.accountId !== undefined ? { accountId: normalizeNullable(input.accountId) } : {}),
      ...(input.accessKeyId !== undefined ? { accessKeyId: preserveSecret(input.accessKeyId, current.accessKeyId) } : {}),
      ...(input.secretAccessKey !== undefined ? { secretAccessKey: preserveSecret(input.secretAccessKey, current.secretAccessKey) } : {}),
      ...(input.localIntervalMinutes !== undefined ? { localIntervalMinutes: integerInRange(input.localIntervalMinutes, 1, 7 * 24 * 60, 'local interval') } : {}),
      ...(input.hotIntervalMinutes !== undefined ? { hotIntervalMinutes: integerInRange(input.hotIntervalMinutes, 1, 7 * 24 * 60, 'frequent upload interval') } : {}),
      ...(input.coldIntervalHours !== undefined ? { coldIntervalHours: integerInRange(input.coldIntervalHours, 1, 30 * 24, 'full upload interval') } : {}),
      ...(input.reconcileIntervalHours !== undefined ? { reconcileIntervalHours: integerInRange(input.reconcileIntervalHours, 1, 30 * 24, 'reconcile interval') } : {}),
      ...(input.keepRecent !== undefined ? { keepRecent: integerInRange(input.keepRecent, 1, 1000, 'recent retention') } : {}),
      ...(input.keepDaily !== undefined ? { keepDaily: integerInRange(input.keepDaily, 0, 365, 'daily retention') } : {}),
      ...(input.keepWeekly !== undefined ? { keepWeekly: integerInRange(input.keepWeekly, 0, 520, 'weekly retention') } : {}),
      ...(input.maxStorageBytes !== undefined ? { maxStorageBytes: integerInRange(input.maxStorageBytes, 1024 * 1024, 1024 ** 4, 'storage ceiling') } : {}),
      ...(input.maxWriteOperations !== undefined ? { maxWriteOperations: integerInRange(input.maxWriteOperations, 1000, 1_000_000_000, 'write ceiling') } : {}),
      ...(input.maxReadOperations !== undefined ? { maxReadOperations: integerInRange(input.maxReadOperations, 1000, 1_000_000_000, 'read ceiling') } : {}),
    };
    validateStoredConfig(next);
    await this.save(next);
    return this.toPublic(next);
  }

  public async testConnection(): Promise<R2ConnectionResult> {
    const config = await this.load();
    try {
      const objects = await this.listAll(config, OBJECT_PREFIX);
      return { ok: true, objectCount: objects.length, totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0) };
    } finally {
      await this.recordCharges();
    }
  }

  /**
   * Every object under the manager's prefix.
   *
   * One listing per thousand objects, each one charged, so this is for when
   * somebody asked to see the bucket - not for telling the panel how many
   * things are in it. The counts it keeps answer that for free.
   */
  public async listObjects(): Promise<R2Object[]> {
    const config = await this.load();
    try {
      return (await this.listAll(config, OBJECT_PREFIX)).map(toPublicObject);
    } finally {
      await this.recordCharges();
    }
  }

  /**
   * Send whatever of this profile the bucket does not already hold.
   *
   * Nothing is compared against the bucket during the run: the ledger says what
   * is already there, which is the difference between a handful of writes and
   * one per file. The snapshot naming every chunk is written last, so a run
   * killed halfway leaves chunks nothing points at - wasted space that the next
   * reconcile collects, never a recovery point with holes in it.
   */
  public async syncProfile(input: R2SyncInput): Promise<R2SyncResult> {
    return await this.exclusive(async () => {
      const config = await this.requireUsable();
      await this.ledger.load();
      const usage = await this.currentPeriod(config);
      if (usage.storageBytes >= config.maxStorageBytes) {
        throw new R2Error('r2_storage_ceiling', `The bucket is holding ${formatBytes(usage.storageBytes)}, at or above the ${formatBytes(config.maxStorageBytes)} ceiling. Lower retention or raise the ceiling.`);
      }
      if (usage.writeOperations >= config.maxWriteOperations) {
        throw new R2Error('r2_operation_ceiling', `${usage.writeOperations} charged writes have been used this month, at or above the ${config.maxWriteOperations} ceiling.`);
      }

      const planned = planUpload(input.sources, this.ledger);
      const client = this.client(config);
      let uploadedChunks = 0;
      let uploadedBytes = 0;
      let completed = 0;
      // What is left to send, which is the only number that says how long this
      // will take. A count of files cannot: one of them is a settings file and
      // the next is a twenty megabyte character card.
      let sentBytes = 0;
      const dropped = new Set<string>();
      const uploadedHashes: string[] = [];
      await runPooled(planned.files, ioConcurrency(), async (entry) => {
        throwIfStopped(input.signal);
        const sent = await this.uploadChunks(client, entry);
        if (sent === null) {
          // Gone since the walk. Naming it in the snapshot would point at a
          // chunk that was never stored, so the file leaves this recovery point.
          dropped.add(entry.source.file.name);
        } else {
          uploadedChunks += sent.hashes.length;
          uploadedBytes += sent.bytes;
          uploadedHashes.push(...sent.hashes);
        }
        completed += 1;
        // Measured as the data it holds rather than as what went over the wire,
        // so the total is known before the first byte is compressed.
        sentBytes += plannedBytes(entry);
        input.onProgress?.({ completedBytes: sentBytes, totalBytes: planned.bytes, completedItems: completed, totalItems: planned.files.length });
      });
      // Only after the bytes are in the bucket, and only once, so an interrupted
      // run never records a chunk it did not finish sending.
      await this.ledger.add(uploadedHashes);

      const files = mergeFiles(input.sources, input.carried ?? [], dropped);
      const createdAt = this.now().toISOString();
      const snapshot: R2Snapshot = {
        schemaVersion: 1,
        id: snapshotId(createdAt),
        createdAt,
        profileId: input.profile.id,
        profileName: input.profile.name,
        layout: input.profile.layout,
        fingerprint: input.fingerprint,
        files,
      };
      const body = await encodeSnapshot(snapshot);
      const key = snapshotKey(OBJECT_PREFIX, input.profile.id, snapshot.id);
      await client.putObject(key, body, 'application/gzip');

      const nextUsage: StoredUsage = {
        ...usage,
        storageBytes: usage.storageBytes + uploadedBytes + body.byteLength,
        blobCount: usage.blobCount + uploadedChunks,
        snapshotCount: usage.snapshotCount + 1,
      };
      await this.save({
        ...config,
        lastUploadAt: createdAt,
        ...(input.tier === 'cold' ? { lastColdUploadAt: createdAt } : {}),
        lastFingerprint: input.fingerprint,
        lastSnapshot: { profileId: input.profile.id, id: snapshot.id },
        usage: nextUsage,
      });
      await this.recordCharges();
      if (dropped.size > 0) this.logger(logEvent('r2.skippedMissingFiles', `[r2] skipped ${dropped.size} file(s) removed while the upload was running`, { count: dropped.size }));
      this.logger(logEvent('r2.synced', `[r2] sent ${uploadedChunks} changed chunk(s), ${formatBytes(uploadedBytes)}, of ${files.length} file(s)`, { chunks: uploadedChunks, bytes: formatBytes(uploadedBytes), files: files.length }));
      return {
        snapshot: { id: snapshot.id, profileId: snapshot.profileId, createdAt: snapshot.createdAt, indexBytes: body.byteLength },
        fileCount: files.length,
        uploadedChunks,
        uploadedBytes,
        reusedChunks: planned.reused,
        usage: toPublicUsage(nextUsage),
      };
    });
  }

  /** The recovery points in the bucket, newest first. */
  public async listSnapshots(profileId?: string): Promise<R2SnapshotSummary[]> {
    const config = await this.load();
    const prefix = profileId ? `${SNAPSHOT_PREFIX}${profileId}/` : SNAPSHOT_PREFIX;
    try {
      return (await this.listAll(config, prefix))
        .map((object) => toSnapshotSummary(object))
        .filter((summary): summary is R2SnapshotSummary => summary !== null)
        .sort((left, right) => right.id.localeCompare(left.id));
    } finally {
      await this.recordCharges();
    }
  }

  /**
   * The recovery point to compare this run against, without asking the bucket.
   *
   * Listing is a charged operation, and the frequent run would make one every
   * few minutes to be told what it wrote itself last time. The stored answer is
   * a cache: anything unexpected about it falls back to the listing, which is
   * still the truth.
   */
  public async latestSnapshot(profileId: string): Promise<R2Snapshot | null> {
    const config = await this.load();
    const remembered = config.lastSnapshot?.profileId === profileId ? config.lastSnapshot.id : null;
    if (remembered) {
      try {
        return await this.readSnapshot(profileId, remembered);
      } catch {
        // Pruned, or never landed. The listing below settles it.
      }
    }
    const listed = (await this.listSnapshots(profileId))[0];
    return listed ? await this.readSnapshot(profileId, listed.id) : null;
  }

  /**
   * Whether there are more recovery points than retention allows.
   *
   * Answered from the local count so that the listing thinning needs is made
   * only when there is something to thin, rather than after every upload.
   */
  public async pruneDue(): Promise<boolean> {
    const config = await this.load();
    return config.usage.snapshotCount > config.keepRecent + config.keepDaily + config.keepWeekly;
  }

  /** Read one recovery point, for showing what it holds or for restoring it. */
  public async readSnapshot(profileId: string, snapshotIdentifier: string): Promise<R2Snapshot> {
    const config = await this.load();
    try {
      return await decodeSnapshot(await this.client(config).getObject(snapshotKey(OBJECT_PREFIX, profileId, snapshotIdentifier)));
    } finally {
      await this.recordCharges();
    }
  }

  /** Fetch one stored chunk, already decoded back to the bytes it holds. */
  public async readBlob(hash: string): Promise<Buffer> {
    const config = await this.load();
    const blob = await decodeBlob(await this.client(config).getObject(blobKey(OBJECT_PREFIX, hash)));
    // A restore is one of these per file. Writing the counters down after each
    // one would be thousands of state writes for a figure nobody reads that
    // often, so they are folded in a few times a minute instead.
    await this.recordCharges({ atMostEvery: 5_000 });
    return blob;
  }

  /**
   * Thin the recovery points down to what retention asks for.
   *
   * Deleting the index is free and does not free any space on its own - the
   * chunks it named are still there, shared with every other snapshot that
   * wants them. Working out which ones nobody wants any more is the reconcile's
   * job, because it is the expensive half.
   */
  public async pruneSnapshots(profileId: string): Promise<R2SnapshotSummary[]> {
    return await this.exclusive(async () => {
      const config = await this.load();
      const snapshots = await this.listSnapshots(profileId);
      const keep = selectRetained(snapshots, config);
      const removed = snapshots.filter((snapshot) => !keep.has(snapshot.id));
      if (removed.length === 0) return [];
      const client = this.client(config);
      for (const snapshot of removed) await client.deleteObject(snapshotKey(OBJECT_PREFIX, profileId, snapshot.id));
      const usage = await this.currentPeriod(config);
      await this.save({
        ...config,
        usage: {
          ...usage,
          snapshotCount: Math.max(0, usage.snapshotCount - removed.length),
        },
      });
      await this.recordCharges();
      this.logger(logEvent('r2.pruned', `[r2] dropped ${removed.length} superseded recovery point(s)`, { count: removed.length }));
      return removed;
    });
  }

  /**
   * Make what the manager believes match what the bucket holds, and take back
   * the space nothing points at any more.
   *
   * This is the only operation that lists the whole store, and the only one
   * whose cost grows with how much is in it, which is why it runs on its own
   * slow clock rather than with every backup.
   */
  public async reconcile(): Promise<R2ReconcileResult> {
    return await this.exclusive(async () => {
      const config = await this.requireUsable();
      const client = this.client(config);
      const objects = await this.listAll(config, OBJECT_PREFIX, client);
      const blobs = new Map<string, S3ObjectRecord>();
      const snapshotKeys: string[] = [];
      let legacyObjectCount = 0;
      let legacyBytes = 0;
      for (const object of objects) {
        if (object.key.startsWith(BLOB_PREFIX)) {
          const hash = object.key.slice(object.key.lastIndexOf('/') + 1);
          if (/^[0-9a-f]{64}$/u.test(hash)) blobs.set(hash, object);
          continue;
        }
        if (object.key.startsWith(SNAPSHOT_PREFIX)) { snapshotKeys.push(object.key); continue; }
        // Whole-ZIP archives from the version before this one. They are not
        // read and not deleted behind the operator's back; the panel offers it.
        legacyObjectCount += 1;
        legacyBytes += object.sizeBytes;
      }

      const snapshots: R2Snapshot[] = [];
      for (const key of snapshotKeys) {
        try {
          snapshots.push(await decodeSnapshot(await client.getObject(key)));
        } catch (error: unknown) {
          // One damaged index must not make every chunk look collectable.
          throw new R2Error('r2_unreadable_snapshot', `A recovery point could not be read, so nothing was collected: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      const wanted = referencedHashes(snapshots);
      let collectedBlobs = 0;
      let collectedBytes = 0;
      const collected: string[] = [];
      for (const [hash, object] of blobs) {
        if (wanted.has(hash)) continue;
        await client.deleteObject(object.key);
        collected.push(hash);
        collectedBlobs += 1;
        collectedBytes += object.sizeBytes;
      }
      for (const hash of collected) blobs.delete(hash);
      await this.ledger.reconcile(blobs.keys());

      const snapshotBytesTotal = objects.filter((object) => object.key.startsWith(SNAPSHOT_PREFIX)).reduce((sum, object) => sum + object.sizeBytes, 0);
      const blobBytesTotal = [...blobs.values()].reduce((sum, object) => sum + object.sizeBytes, 0);
      const previous = await this.currentPeriod(config);
      const usage: StoredUsage = {
        storageBytes: blobBytesTotal + snapshotBytesTotal + legacyBytes,
        blobCount: blobs.size,
        snapshotCount: snapshots.length,
        writeOperations: previous.writeOperations,
        readOperations: previous.readOperations,
        periodStartedAt: previous.periodStartedAt,
        legacyObjectCount,
        legacyBytes,
        lastReconciledAt: this.now().toISOString(),
      };
      await this.save({ ...config, usage });
      await this.recordCharges();
      this.logger(logEvent('r2.reconciled', `[r2] ${blobs.size} stored chunk(s), ${formatBytes(usage.storageBytes)}; collected ${collectedBlobs}`, { chunks: blobs.size, size: formatBytes(usage.storageBytes), collected: collectedBlobs }));
      return { blobCount: blobs.size, collectedBlobs, collectedBytes, usage: toPublicUsage(usage) };
    });
  }

  /**
   * Remove the whole-ZIP archives the previous scheme uploaded.
   *
   * Never automatic. They are the operator's backups, taken under a design that
   * no longer runs, and deciding they are worthless is not this manager's call
   * to make on its own.
   */
  public async deleteLegacyObjects(): Promise<{ removed: number; bytes: number }> {
    return await this.exclusive(async () => {
      const config = await this.requireUsable();
      const client = this.client(config);
      const objects = await this.listAll(config, OBJECT_PREFIX, client);
      const legacy = objects.filter((object) => !object.key.startsWith(BLOB_PREFIX) && !object.key.startsWith(SNAPSHOT_PREFIX));
      let bytes = 0;
      for (const object of legacy) {
        await client.deleteObject(object.key);
        bytes += object.sizeBytes;
      }
      const usage = await this.currentPeriod(config);
      await this.save({
        ...config,
        usage: {
          ...usage,
          storageBytes: Math.max(0, usage.storageBytes - bytes),
          legacyObjectCount: 0,
          legacyBytes: 0,
        },
      });
      await this.recordCharges();
      this.logger(logEvent('r2.legacyRemoved', `[r2] removed ${legacy.length} archive(s) in the old whole-file format, ${formatBytes(bytes)}`, { count: legacy.length, size: formatBytes(bytes) }));
      return { removed: legacy.length, bytes };
    });
  }

  public async deleteObject(key: string): Promise<void> {
    if (!key.startsWith(OBJECT_PREFIX) || key.includes('..')) throw new R2Error('invalid_object_key', 'The R2 object key is invalid');
    const config = await this.load();
    await this.client(config).deleteObject(key);
    await this.recordCharges();
  }

  public async markFingerprint(fingerprint: string): Promise<void> {
    const config = await this.load();
    await this.save({ ...config, lastFingerprint: fingerprint });
  }

  /** Upload every chunk of one file the bucket is missing, or report the file is gone. */
  private async uploadChunks(client: R2Client, entry: PlannedFile): Promise<{ hashes: string[]; bytes: number } | null> {
    let handle;
    try {
      handle = await open(entry.source.path, 'r');
    } catch (error: unknown) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
    try {
      const hashes: string[] = [];
      let bytes = 0;
      const compress = shouldCompress(entry.source.file.name);
      for (const chunk of entry.chunks) {
        const raw = Buffer.allocUnsafe(chunk.length);
        const { bytesRead } = await handle.read(raw, 0, chunk.length, chunk.offset);
        // The file changed under the walk. The snapshot describes what was
        // hashed, so a short read means this file no longer matches it.
        if (bytesRead !== chunk.length) return null;
        const body = await encodeBlob(raw, compress);
        await client.putObject(blobKey(OBJECT_PREFIX, chunk.hash), body, 'application/octet-stream');
        hashes.push(chunk.hash);
        bytes += body.byteLength;
      }
      return { hashes, bytes };
    } catch (error: unknown) {
      if (isFileNotFound(error)) return null;
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async listAll(config: StoredR2Config, prefix: string, client?: R2Client): Promise<S3ObjectRecord[]> {
    const target = client ?? this.client(config);
    const objects: S3ObjectRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await target.listObjects(prefix, LIST_PAGE_KEYS, cursor);
      objects.push(...page.objects);
      cursor = page.cursor;
    } while (cursor);
    return objects;
  }

  private async requireUsable(): Promise<StoredR2Config> {
    const config = await this.load();
    if (!config.enabled) throw new R2Error('r2_disabled', 'R2 backup is switched off');
    toCredentials(config);
    return config;
  }

  /** The usage counters, with the charged-write count reset when the month turns over. */
  private async currentPeriod(config: StoredR2Config): Promise<StoredUsage> {
    const period = monthStart(this.now());
    if (config.usage.periodStartedAt === period) return config.usage;
    return { ...config.usage, writeOperations: 0, periodStartedAt: period };
  }

  private client(config: StoredR2Config): R2Client {
    return new R2Client(toCredentials(config), this.fetchImpl, (kind) => {
      if (kind === 'charged') this.charges.write += 1;
      else if (kind === 'read') this.charges.read += 1;
    });
  }

  /**
   * Write down what has been charged since the last time.
   *
   * Called at the end of every operation that talks to R2, including the ones
   * that only read, so the figure the panel shows is the whole bill rather than
   * the part that happened to pass through a saved result.
   */
  private async recordCharges(options: { readonly atMostEvery?: number } = {}): Promise<void> {
    if (this.charges.write === 0 && this.charges.read === 0) return;
    const since = this.now().getTime() - this.chargesWrittenAt;
    if (options.atMostEvery !== undefined && since < options.atMostEvery) return;
    this.chargesWrittenAt = this.now().getTime();
    const config = await this.load();
    const usage = await this.currentPeriod(config);
    const taken = this.charges;
    this.charges = { write: 0, read: 0 };
    await this.save({
      ...config,
      usage: { ...usage, writeOperations: usage.writeOperations + taken.write, readOperations: usage.readOperations + taken.read },
    });
  }

  /** Run one whole-store operation at a time, whatever else is asked for meanwhile. */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.busy.then(operation, operation);
    this.busy = run.catch(() => undefined);
    return await run;
  }

  private toPublic(config: StoredR2Config): R2Config {
    return {
      enabled: config.enabled,
      endpoint: config.endpoint,
      bucket: config.bucket,
      accountId: config.accountId,
      configured: Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey),
      lastUploadAt: config.lastUploadAt,
      accessKeyIdMasked: config.accessKeyId ? maskSecret(config.accessKeyId) : null,
      secretAccessKeyConfigured: Boolean(config.secretAccessKey),
      schedule: {
        localIntervalMinutes: config.localIntervalMinutes,
        hotIntervalMinutes: config.hotIntervalMinutes,
        coldIntervalHours: config.coldIntervalHours,
        reconcileIntervalHours: config.reconcileIntervalHours,
      },
      retention: { keepRecent: config.keepRecent, keepDaily: config.keepDaily, keepWeekly: config.keepWeekly },
      limits: { maxStorageBytes: config.maxStorageBytes, maxWriteOperations: config.maxWriteOperations, maxReadOperations: config.maxReadOperations },
      usage: toPublicUsage(config.usage),
      lastFingerprint: config.lastFingerprint,
    };
  }

  /** When the cold tier is next owed a run, which the scheduler asks about. */
  public async coldDue(): Promise<boolean> {
    const config = await this.load();
    if (!config.lastColdUploadAt) return true;
    const elapsed = this.now().getTime() - Date.parse(config.lastColdUploadAt);
    return !Number.isFinite(elapsed) || elapsed >= config.coldIntervalHours * 60 * 60 * 1000;
  }

  /** Whether a listing of the whole store is owed, which is the only costly sweep. */
  public async reconcileDue(): Promise<boolean> {
    const config = await this.load();
    if (!config.usage.lastReconciledAt) return true;
    const elapsed = this.now().getTime() - Date.parse(config.usage.lastReconciledAt);
    return !Number.isFinite(elapsed) || elapsed >= config.reconcileIntervalHours * 60 * 60 * 1000;
  }

  private async load(): Promise<StoredR2Config> {
    if (this.configState) return this.configState;
    await mkdir(this.paths.state, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, R2_STATE_FILE), 'utf8'));
      this.configState = parseStoredConfig(parsed);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      const fromEnvironment: StoredR2Config = {
        ...defaultStoredConfig(this.now()),
        enabled: Boolean(this.env.STM_R2_ENDPOINT && this.env.STM_R2_BUCKET && this.env.STM_R2_ACCESS_KEY_ID && this.env.STM_R2_SECRET_ACCESS_KEY),
        endpoint: nullableEnvironment(this.env.STM_R2_ENDPOINT),
        bucket: nullableEnvironment(this.env.STM_R2_BUCKET),
        accountId: nullableEnvironment(this.env.STM_R2_ACCOUNT_ID),
        accessKeyId: nullableEnvironment(this.env.STM_R2_ACCESS_KEY_ID),
        secretAccessKey: nullableEnvironment(this.env.STM_R2_SECRET_ACCESS_KEY),
      };
      validateStoredConfig(fromEnvironment);
      await this.save(fromEnvironment);
    }
    if (!this.configState) throw new Error('R2 configuration could not be loaded');
    return this.configState;
  }

  private async save(config: StoredR2Config): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, R2_STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.configState = config;
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }
}

interface PlannedFile {
  readonly source: SyncSource;
  readonly chunks: readonly FileChunk[];
}

interface UploadPlan {
  readonly files: readonly PlannedFile[];
  readonly reused: number;
  /** How much data has to go, for saying how long that will take. */
  readonly bytes: number;
}

function plannedBytes(entry: PlannedFile): number {
  let total = 0;
  for (const chunk of entry.chunks) total += chunk.length;
  return total;
}

/**
 * Decide what actually has to be sent.
 *
 * A chunk shared by two files is claimed by the first one here rather than
 * being raced for during the upload: identical content is identical wherever it
 * came from, so sending it once is both correct and the point.
 */
function planUpload(sources: readonly SyncSource[], ledger: BlobLedger): UploadPlan {
  const claimed = new Set<string>();
  const files: PlannedFile[] = [];
  let reused = 0;
  for (const source of sources) {
    const chunks = source.file.chunks.filter((chunk) => {
      if (ledger.has(chunk.hash) || claimed.has(chunk.hash)) { reused += 1; return false; }
      claimed.add(chunk.hash);
      return true;
    });
    if (chunks.length > 0) files.push({ source, chunks });
  }
  return { files, reused, bytes: files.reduce((sum, entry) => sum + plannedBytes(entry), 0) };
}

/** The complete file list for a snapshot: what this run walked, plus what it carried. */
function mergeFiles(sources: readonly SyncSource[], carried: readonly HashedFile[], dropped: ReadonlySet<string>): HashedFile[] {
  const files = new Map<string, HashedFile>();
  for (const file of carried) if (!dropped.has(file.name)) files.set(file.name, file);
  for (const source of sources) if (!dropped.has(source.file.name)) files.set(source.file.name, source.file);
  return [...files.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Which recovery points survive: the newest few, then one a day, then one a week.
 *
 * Thinning rather than expiring is what makes a five-minute schedule affordable
 * to keep: an hour ago is worth every point, last month is worth one.
 */
function selectRetained(snapshots: readonly R2SnapshotSummary[], config: { keepRecent: number; keepDaily: number; keepWeekly: number }): Set<string> {
  const ordered = [...snapshots].sort((left, right) => right.id.localeCompare(left.id));
  const keep = new Set<string>(ordered.slice(0, config.keepRecent).map((snapshot) => snapshot.id));
  const claimFirst = (limit: number, bucket: (snapshot: R2SnapshotSummary) => string): void => {
    const seen = new Set<string>();
    for (const snapshot of ordered) {
      const period = bucket(snapshot);
      if (seen.has(period)) continue;
      seen.add(period);
      if (seen.size > limit) return;
      keep.add(snapshot.id);
    }
  };
  claimFirst(config.keepDaily, (snapshot) => snapshot.createdAt.slice(0, 10));
  claimFirst(config.keepWeekly, (snapshot) => isoWeek(snapshot.createdAt));
  return keep;
}

/** The ISO week a timestamp falls in, so "one a week" means the same week to everyone. */
function isoWeek(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp.slice(0, 10);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday decides the year a week belongs to, which is what makes the turn
  // of the year one week rather than two partial ones.
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function toSnapshotSummary(object: S3ObjectRecord): R2SnapshotSummary | null {
  const rest = object.key.slice(SNAPSHOT_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator <= 0 || !rest.endsWith('.json.gz')) return null;
  const identifier = rest.slice(separator + 1, -'.json.gz'.length);
  if (!identifier) return null;
  return { id: identifier, profileId: rest.slice(0, separator), createdAt: snapshotTimestamp(identifier), indexBytes: object.sizeBytes };
}

/**
 * Snapshot names are timestamps with the punctuation a key cannot carry.
 *
 * Naming them this way means a listing comes back in chronological order and
 * retention never has to read a single index to know what is oldest.
 */
function snapshotId(createdAt: string): string {
  return createdAt.replace(/[:.]/gu, '-');
}

function snapshotTimestamp(identifier: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u.exec(identifier);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : identifier;
}

function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
}

function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new R2Error('r2_upload_stopped', 'The upload was stopped');
}

class R2Client {
  private readonly region = 'auto';
  private readonly service = 's3';

  public constructor(
    private readonly credentials: R2Credentials,
    private readonly fetchImpl: typeof fetch,
    /** Told about every request that Cloudflare charges for, as it is made. */
    private readonly onRequest: (billing: 'charged' | 'read' | 'free') => void,
  ) {}

  public async listObjects(prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: S3ObjectRecord[]; cursor: string | undefined }> {
    const query = new URLSearchParams([['list-type', '2'], ['prefix', prefix], ['max-keys', String(maxKeys)]]);
    if (cursor) query.set('continuation-token', cursor);
    const response = await this.request('GET', '', null, query, {}, 'charged');
    const body = await response.text();
    const objects: S3ObjectRecord[] = [];
    for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
      const content = match[1] ?? '';
      const key = decodeXml(readXmlTag(content, 'Key') ?? '');
      if (!key) continue;
      const size = Number(readXmlTag(content, 'Size') ?? 0);
      objects.push({ key, sizeBytes: Number.isFinite(size) ? size : 0, lastModified: readXmlTag(content, 'LastModified'), etag: readXmlTag(content, 'ETag') });
    }
    // A store of tens of thousands of chunks does not fit one page, and a
    // listing that stopped at the first one made every chunk past it look
    // absent - which would have meant uploading them all again, every time.
    const truncated = readXmlTag(body, 'IsTruncated') === 'true';
    const next = readXmlTag(body, 'NextContinuationToken');
    return { objects, cursor: truncated && next ? decodeXml(next) : undefined };
  }

  public async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.request('PUT', key, body, undefined, { 'content-type': contentType, 'content-length': String(body.byteLength) }, 'charged');
  }

  public async getObject(key: string): Promise<Buffer> {
    const response = await this.request('GET', key, null, undefined, {}, 'read');
    return Buffer.from(await response.arrayBuffer());
  }

  public async deleteObject(key: string): Promise<void> {
    await this.request('DELETE', key, null, undefined, {}, 'free');
  }

  private async request(method: string, key: string, body: BodyInit | Uint8Array | null, query?: URLSearchParams, extraHeaders: Record<string, string> = {}, billing: 'charged' | 'read' | 'free' = 'read'): Promise<Response> {
    const url = objectUrl(this.credentials.endpoint, this.credentials.bucket, key, query);
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const amzDate = formatAmzDate(new Date());
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders };
    const { authorization } = signRequest({ method, url, headers, payloadHash, accessKeyId: this.credentials.accessKeyId, secretAccessKey: this.credentials.secretAccessKey, region: this.region, service: this.service });
    headers.authorization = authorization;
    const init = { method, headers, ...(body === null ? {} : { body: body as BodyInit }), duplex: 'half' } as RequestInit & { duplex: 'half' };
    this.onRequest(billing);
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      const message = (await response.text()).slice(0, 500);
      throw new R2HttpError(response.status, `R2 request failed (${response.status}): ${message || response.statusText}`);
    }
    return response;
  }
}

function signRequest(options: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; accessKeyId: string; secretAccessKey: string; region: string; service: string }): { authorization: string } {
  const normalizedHeaders = Object.entries(options.headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/gu, ' ')] as const).sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = normalizedHeaders.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = normalizedHeaders.map(([name]) => name).join(';');
  const canonicalQuery = canonicalQueryString(options.url.searchParams);
  const canonicalRequest = [options.method, options.url.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, options.payloadHash].join('\n');
  const date = options.headers['x-amz-date']?.slice(0, 8) ?? formatAmzDate(new Date()).slice(0, 8);
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${options.headers['x-amz-date']}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmacDigest(`AWS4${options.secretAccessKey}`, date);
  const regionKey = hmacDigest(dateKey, options.region);
  const serviceKey = hmacDigest(regionKey, options.service);
  const signingKey = hmacDigest(serviceKey, 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  return { authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

function objectUrl(endpoint: string, bucket: string, key: string, query?: URLSearchParams): URL {
  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  const encodedKey = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const url = new URL(`${base}/${encodeURIComponent(bucket)}${encodedKey ? `/${encodedKey}` : ''}`);
  if (query) url.search = canonicalQueryString(query);
  return url;
}

function canonicalQueryString(query: URLSearchParams): string {
  return [...query.entries()].map(([key, value]) => [rfc3986(key), rfc3986(value)] as const).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}=${value}`).join('&');
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacDigest(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return hmacDigest(key, value).toString('hex');
}

function toCredentials(config: StoredR2Config): R2Credentials {
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new R2Error('r2_not_configured', 'Configure the R2 endpoint, bucket, access key, and secret key first');
  return { endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
}

function validateStoredConfig(config: StoredR2Config): void {
  if (config.endpoint !== null) {
    let parsed: URL;
    try { parsed = new URL(config.endpoint); } catch { throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must be a valid HTTPS URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must use HTTPS');
    if (parsed.search || parsed.hash) throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must not contain a query or fragment');
  }
  if (config.bucket !== null && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket)) throw new R2Error('invalid_r2_bucket', 'R2 bucket name is invalid');
}

/**
 * Read the stored settings, including one written by the version that uploaded
 * whole ZIP files.
 *
 * What the operator typed is kept - the endpoint, the bucket and the keys are
 * not something to make them find again. The schedule and retention are not:
 * they described a different scheme, and carrying "keep 7 archives" forward
 * into one where a recovery point is an index would mean nothing.
 */
function parseStoredConfig(value: unknown): StoredR2Config {
  if (!isRecord(value)) throw new Error('Unsupported R2 configuration schema');
  const defaults = defaultStoredConfig(new Date());
  if (value.schemaVersion === 1) {
    const migrated: StoredR2Config = {
      ...defaults,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
      endpoint: typeof value.endpoint === 'string' ? value.endpoint : null,
      bucket: typeof value.bucket === 'string' ? value.bucket : null,
      accountId: typeof value.accountId === 'string' ? value.accountId : null,
      accessKeyId: typeof value.accessKeyId === 'string' ? value.accessKeyId : null,
      secretAccessKey: typeof value.secretAccessKey === 'string' ? value.secretAccessKey : null,
      localIntervalMinutes: typeof value.localIntervalMinutes === 'number' ? value.localIntervalMinutes : defaults.localIntervalMinutes,
    };
    validateStoredConfig(migrated);
    return migrated;
  }
  if (value.schemaVersion !== R2_SCHEMA_VERSION) throw new Error('Unsupported R2 configuration schema');
  const usage = isRecord(value.usage) ? value.usage : {};
  const config: StoredR2Config = {
    ...defaults,
    ...value,
    schemaVersion: R2_SCHEMA_VERSION,
    usage: { ...defaults.usage, ...usage } as StoredUsage,
  } as StoredR2Config;
  validateStoredConfig(config);
  return config;
}

function defaultStoredConfig(now: Date): StoredR2Config {
  return {
    schemaVersion: R2_SCHEMA_VERSION,
    enabled: false,
    endpoint: null,
    bucket: null,
    accountId: null,
    accessKeyId: null,
    secretAccessKey: null,
    ...DEFAULTS,
    lastUploadAt: null,
    lastColdUploadAt: null,
    lastFingerprint: null,
    lastSnapshot: null,
    usage: {
      storageBytes: 0,
      blobCount: 0,
      snapshotCount: 0,
      writeOperations: 0,
      readOperations: 0,
      periodStartedAt: monthStart(now),
      legacyObjectCount: 0,
      legacyBytes: 0,
      lastReconciledAt: null,
    },
  };
}

function toPublicUsage(usage: StoredUsage): R2Usage {
  return { ...usage };
}

function normalizeNullable(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function preserveSecret(value: string | null, previous: string | null): string | null {
  if (value === MASKED_SECRET) return previous;
  return normalizeNullable(value);
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new R2Error('invalid_r2_schedule', `The ${label} is out of range`);
  return value;
}

function maskSecret(value: string): string {
  if (value.length <= 4) return MASKED_SECRET;
  return `${value.slice(0, 2)}${MASKED_SECRET}${value.slice(-2)}`;
}

function toPublicObject(object: S3ObjectRecord): R2Object {
  return { key: object.key, sizeBytes: object.sizeBytes, lastModified: object.lastModified, etag: object.etag };
}

function readXmlTag(value: string, tag: string): string | null {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(value)?.[1] ?? null;
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}

function nullableEnvironment(value: string | undefined): string | null {
  return value?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'EISDIR');
}
