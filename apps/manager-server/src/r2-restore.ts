import { Readable } from 'node:stream';
import { logEvent, type BackupManifest, type LogSink, type Profile, type RestorePreview } from '../../../packages/contracts/src/index.js';
import { BackupStore, type ImportEntry } from '../../../packages/backup/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import type { HashedFile } from '../../../packages/r2/src/sync.js';
import { ioConcurrency } from '../../../packages/platform/src/index.js';

/**
 * How large a file may be and still be fetched ahead of when it is needed.
 *
 * A profile is mostly small files, and fetching them one at a time means one
 * network round trip each: eleven thousand of those in a row is most of an
 * hour of waiting on latency rather than on bandwidth. Reading ahead fixes
 * that, and the size limit is what stops reading ahead from holding several
 * large files in memory at once - those are few, and their round trips are
 * already paid for by the megabytes that follow them.
 */
const PREFETCH_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface FetchSnapshotOptions {
  readonly profile: Profile;
  readonly r2: R2Manager;
  readonly backups: BackupStore;
  readonly snapshotId: string;
  readonly logger?: LogSink;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
}

/**
 * Bring one recovery point back from R2 into the local backup library.
 *
 * It arrives as an ordinary archive, which is the point: restoring it is then
 * the path that already exists and has been proven, rather than a second way
 * of writing into a profile that would have to be made safe all over again.
 */
export async function fetchSnapshotToLibrary(options: FetchSnapshotOptions): Promise<{ manifest: BackupManifest; preview: RestorePreview }> {
  const { profile, r2, backups, snapshotId } = options;
  const snapshot = await r2.readSnapshot(profile.id, snapshotId);
  const files = [...snapshot.files].sort((left, right) => left.name.localeCompare(right.name));
  options.logger?.(logEvent('r2.fetching', `[r2] fetching recovery point ${snapshot.createdAt} (${files.length} files)`, { createdAt: snapshot.createdAt, files: files.length }));
  const result = await backups.importFromEntries(profile, {
    name: `${profile.name}-r2-${snapshotId}`,
    total: files.length,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    entries: entriesFor(r2, files, options.signal),
  });
  options.logger?.(logEvent('r2.fetched', `[r2] recovery point ${snapshot.createdAt} is in the backup library as ${result.manifest.name}`, { createdAt: snapshot.createdAt, name: result.manifest.name }));
  return result;
}

/**
 * The archive entries for a recovery point, in order, reading ahead where it pays.
 *
 * Order matters because the archive is written as it is produced, so this
 * cannot simply fetch whatever finishes first.
 */
async function* entriesFor(r2: R2Manager, files: readonly HashedFile[], signal?: AbortSignal): AsyncGenerator<ImportEntry> {
  for await (const { file, buffered } of readAhead(r2, files, Math.max(1, ioConcurrency()), signal)) {
    yield {
      name: file.name,
      // A file small enough to have been read ahead is already here. A large
      // one is streamed a chunk at a time, so its size is never its cost in
      // memory.
      body: buffered ? Readable.from([buffered]) : Readable.from(chunkStream(r2, file, signal)),
    };
  }
}

async function* chunkStream(r2: R2Manager, file: HashedFile, signal?: AbortSignal): AsyncGenerator<Buffer> {
  for (const chunk of file.chunks) {
    throwIfStopped(signal);
    yield await r2.readBlob(chunk.hash);
  }
}

/**
 * Fetch up to `limit` files at once while handing them back in the original order.
 *
 * Every started fetch is settled before it is looked at, so one that fails does
 * not reject with nobody listening - an unhandled rejection ends the manager
 * process, and this runs against a network that does fail.
 */
async function* readAhead(r2: R2Manager, files: readonly HashedFile[], limit: number, signal?: AbortSignal): AsyncGenerator<{ file: HashedFile; buffered: Buffer | null }> {
  type Settled = { file: HashedFile; buffered: Buffer | null; error?: unknown };
  const inFlight: Array<Promise<Settled>> = [];
  let next = 0;
  const fill = (): void => {
    while (inFlight.length < limit && next < files.length) {
      const file = files[next]!;
      next += 1;
      inFlight.push(load(r2, file, signal).then(
        (buffered) => ({ file, buffered }),
        (error: unknown) => ({ file, buffered: null, error }),
      ));
    }
  };
  fill();
  while (inFlight.length > 0) {
    const settled = await inFlight.shift()!;
    fill();
    if (settled.error !== undefined) throw settled.error;
    yield settled;
  }
}

async function load(r2: R2Manager, file: HashedFile, signal?: AbortSignal): Promise<Buffer | null> {
  throwIfStopped(signal);
  if (file.sizeBytes > PREFETCH_MAX_FILE_BYTES) return null;
  if (file.chunks.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (const chunk of file.chunks) parts.push(await r2.readBlob(chunk.hash));
  return Buffer.concat(parts);
}

function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The download was stopped');
}
