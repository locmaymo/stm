import { statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BackupError, type BackupStore, type RestoreEstimate } from '../../../packages/backup/src/index.js';
import type { Profile, RestoreCapacity, RestoreMode, StorageMedium } from '../../../packages/contracts/src/index.js';
import { storageMedium } from '../../../packages/platform/src/index.js';

/**
 * Kept free after a restore, for SillyTavern and the manager to run in.
 *
 * SillyTavern takes a few hundred megabytes once it has started, and a
 * restore that fits only by leaving it none has not left a working machine.
 */
export const RESTORE_RESERVE_BYTES = 512 * 1024 ** 2;
/** Below this much room, a restore stops where it is rather than take the machine down. */
export const RESTORE_FLOOR_BYTES = 192 * 1024 ** 2;
/** How often a running restore looks again; the look is a statfs and a counter. */
const GUARD_INTERVAL_MS = 200;

/** How many times, and how far apart, the room is looked at again after old files go. */
const SETTLE_ATTEMPTS = 10;
const SETTLE_INTERVAL_MS = 500;

export interface Headroom {
  /** Memory this process may still take, within any container limit. */
  readonly memoryBytes: number;
  /** Space left on the filesystem the profile is on; null when files are kept in memory or it cannot be asked. */
  readonly diskBytes: number | null;
  /** The room for what a restore writes: the memory where files are kept in it, the disk otherwise. */
  readonly bytes: number;
}

/** What the data directories are on, asked once each; the answer is the host's and does not change. */
const media = new Map<string, StorageMedium>();

function mediumOf(path: string): StorageMedium {
  let medium = media.get(path);
  if (!medium) { medium = storageMedium(path); media.set(path, medium); }
  return medium;
}

/**
 * How much room is left for what a restore writes.
 *
 * One limit, and which one depends on the machine. Where files are kept in
 * memory, a file written takes the memory the programs run in, and the disk
 * `statfs` reports is the host's - hundreds of gigabytes the container cannot
 * use. Everywhere else a file takes disk, and memory is not the limit: a
 * phone with four gigabytes of it restores a profile of any size its storage
 * has room for. Taking the smaller of the two, as this once did, refused
 * exactly that phone.
 *
 * `availableMemory` reads the container's own limit where there is one; the
 * machine's free memory is what there is otherwise. A disk that cannot be
 * asked falls back to memory, the cautious answer rather than none.
 */
export async function measureHeadroom(path: string): Promise<Headroom> {
  const memoryBytes = typeof process.availableMemory === 'function' ? process.availableMemory() : freemem();
  if (mediumOf(path).inMemory) return { memoryBytes, diskBytes: null, bytes: memoryBytes };
  const diskBytes = await diskSpace(path);
  return { memoryBytes, diskBytes, bytes: diskBytes ?? memoryBytes };
}

/** Whether a restore of this size fits in this much room, whole and without its junk. */
export function capacityOf(estimate: RestoreEstimate, headroom: Headroom): RestoreCapacity {
  const availableBytes = Math.max(0, headroom.bytes - RESTORE_RESERVE_BYTES);
  const neededBytes = Math.max(0, estimate.incomingBytes - estimate.freedBytes);
  const trimmedNeededBytes = Math.max(0, estimate.incomingBytes - estimate.junkBytes - estimate.freedBytes);
  return {
    availableBytes, neededBytes, trimmedNeededBytes,
    junkBytes: estimate.junkBytes, junkFiles: estimate.junkFiles,
    fits: neededBytes <= availableBytes,
    fitsTrimmed: trimmedNeededBytes <= availableBytes,
  };
}

type RestoreSource = Parameters<BackupStore['estimate']>[1];
/** How room is measured; tests hand in a machine of the size they need. */
type Measure = (path: string) => Promise<Headroom>;

/** The capacity answer for both modes, for a dialog that lets the reader choose. */
export async function capacityFor(backups: BackupStore, profile: Profile, source: RestoreSource, measure: Measure = measureHeadroom): Promise<Record<RestoreMode, RestoreCapacity>> {
  const headroom = await measure(profile.dataPath);
  const [replace, merge] = await Promise.all([backups.estimate(profile, source, 'replace'), backups.estimate(profile, source, 'merge')]);
  return { replace: capacityOf(replace, headroom), merge: capacityOf(merge, headroom) };
}

/**
 * Whether this restore may go ahead as asked; the refusal says why.
 *
 * Saver mode only: a machine with room to spare never asks.
 */
export async function checkFits(backups: BackupStore, profile: Profile, source: RestoreSource, mode: RestoreMode, trim: boolean, measure: Measure = measureHeadroom): Promise<void> {
  if (!backups.saving) return;
  const capacity = capacityOf(await backups.estimate(profile, source, mode), await measure(profile.dataPath));
  if (trim ? capacity.fitsTrimmed : capacity.fits) return;
  throw new BackupError('restore_too_large', `This restore needs ${megabytes(trim ? capacity.trimmedNeededBytes : capacity.neededBytes)} and this machine has room for ${megabytes(capacity.availableBytes)}`);
}

/**
 * Decide for a restore nobody is watching: whole if it fits, without its junk
 * if only that fits, and not at all otherwise.
 */
export async function decideTrim(backups: BackupStore, profile: Profile, source: RestoreSource, mode: RestoreMode, measure: Measure = measureHeadroom): Promise<{ readonly trim: boolean; readonly capacity: RestoreCapacity | null } | null> {
  if (!backups.saving) return { trim: false, capacity: null };
  const capacity = capacityOf(await backups.estimate(profile, source, mode), await measure(profile.dataPath));
  if (capacity.fits) return { trim: false, capacity };
  if (capacity.fitsTrimmed) return { trim: true, capacity };
  return null;
}

/**
 * A checkpoint that stops a restore about to fill the machine.
 *
 * Looked at between files and between uploaded chunks, at most every few
 * hundred milliseconds, and the look in flight is shared by every writer
 * asking at once. The estimate before the restore is the first defence; this
 * is for what it could not see - SillyTavern's own memory, a log growing, a
 * filesystem that counts differently from how files are sized.
 */
export function memoryGuard(path: string, measure: Measure = measureHeadroom): () => Promise<void> {
  let lastAt = 0;
  let pending: Promise<void> | null = null;
  // Once it has said stop, it goes on saying it to every writer that asks.
  let tripped: BackupError | null = null;
  return async () => {
    if (tripped) throw tripped;
    if (pending) return await pending;
    if (Date.now() - lastAt < GUARD_INTERVAL_MS) return;
    pending = (async () => {
      const headroom = await measure(path);
      lastAt = Date.now();
      if (headroom.bytes < RESTORE_FLOOR_BYTES) {
        tripped = new BackupError('restore_out_of_memory', `The restore was stopped with ${megabytes(headroom.bytes)} of room left, before this machine ran out`);
        throw tripped;
      }
    })();
    try { await pending; } finally { pending = null; }
  };
}

/**
 * Asked once a saver mode restore has removed the files it replaces, before
 * it writes: whether what is left to write still fits.
 *
 * The estimate before the restore counted the old files as room already. On a
 * host that keeps files in memory, the memory a deleted file held can come
 * back some time after the delete rather than with it, and a restore that
 * started writing on the estimate's word would find the room missing halfway
 * through. So the room is measured again, and given a few seconds to come
 * back if it is short, and the restore stops here - before writing anything -
 * if it never does.
 */
export function roomCheck(path: string, measure: Measure = measureHeadroom, timing: { readonly attempts: number; readonly intervalMs: number } = { attempts: SETTLE_ATTEMPTS, intervalMs: SETTLE_INTERVAL_MS }): (neededBytes: number) => Promise<void> {
  return async (neededBytes) => {
    for (let attempt = 1; ; attempt += 1) {
      const availableBytes = Math.max(0, (await measure(path)).bytes - RESTORE_RESERVE_BYTES);
      if (neededBytes <= availableBytes) return;
      if (attempt >= timing.attempts) {
        throw new BackupError('restore_too_large', `With the old files removed, this machine has room for ${megabytes(availableBytes)} and the rest of this restore needs ${megabytes(neededBytes)}`);
      }
      await delay(timing.intervalMs);
    }
  };
}

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Free space where `path` is, looking at the nearest directory that exists. */
export async function diskSpace(path: string): Promise<number | null> {
  let current = path;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const stats = await statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}
