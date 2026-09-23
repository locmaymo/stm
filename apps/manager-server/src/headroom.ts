import { statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import { dirname } from 'node:path';
import { BackupError, type BackupStore, type RestoreEstimate } from '../../../packages/backup/src/index.js';
import type { Profile, RestoreCapacity, RestoreMode } from '../../../packages/contracts/src/index.js';

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

export interface Headroom {
  /** Memory this process may still take, within any container limit. */
  readonly memoryBytes: number;
  /** Space left on the filesystem the profile is on, or null when it cannot be asked. */
  readonly diskBytes: number | null;
  /** The smaller of the two: whichever runs out first ends the restore. */
  readonly bytes: number;
}

/**
 * How much room is left for what a restore writes.
 *
 * Both limits, because either can be the one: on an ordinary machine a file
 * written takes disk, and on a host that keeps its files in memory - Cloud
 * Run, which is what a studio's `run.app` address is - it takes the memory
 * the programs run in. `availableMemory` reads the container's own limit
 * where there is one; the machine's free memory is what there is otherwise.
 */
export async function measureHeadroom(path: string): Promise<Headroom> {
  const memoryBytes = typeof process.availableMemory === 'function' ? process.availableMemory() : freemem();
  const diskBytes = await diskSpace(path);
  return { memoryBytes, diskBytes, bytes: Math.min(memoryBytes, diskBytes ?? Number.POSITIVE_INFINITY) };
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

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Free space where `path` is, looking at the nearest directory that exists. */
async function diskSpace(path: string): Promise<number | null> {
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
