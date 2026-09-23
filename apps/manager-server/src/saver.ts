import { totalmem } from 'node:os';
import type { SaverSource, SaverState, StorageMedium } from '../../../packages/contracts/src/index.js';

/**
 * Below this much free disk at startup, saver mode is on unless somebody says
 * otherwise.
 *
 * Five gibibytes, because a restore of an ordinary profile with its safety
 * copy and a scheduled backup beside it takes a few, and a machine with less
 * than that left is one a full backup could fill.
 */
export const SAVER_DISK_THRESHOLD_BYTES = 5 * 1024 ** 3;

/** What the machine is taken to be when nothing was measured. */
const ON_DISK: StorageMedium = { inMemory: false, signal: null };

export interface SaverModeOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** The panel's stored choice, or null when nobody has made one. */
  readonly choice: boolean | null;
  /** Whether files here are kept in memory; see `storageMedium`. */
  readonly storage?: StorageMedium;
  /** Free disk where the manager keeps its data, or null when it could not be asked. */
  readonly diskBytes?: number | null;
  /** Injectable for tests; defaults to what this process may use. */
  readonly memoryBytes?: number;
}

/**
 * Whether the manager keeps disk and memory to the minimum.
 *
 * A restore of a 2 GB profile used to hold it three times over: the uploaded
 * zip, a compressed safety copy of the profile it was about to replace, and
 * the files themselves. On a machine with four gigabytes for everything, that
 * was the end of the machine. Saver mode takes no local archives at all - the
 * copy in R2 stands in for the safety copy - so a profile is on the disk once.
 *
 * Decided once, at startup: STM_SAVER when it is set, which the panel cannot
 * override; the panel's switch when it has been pressed; otherwise the
 * machine. The panel's switch then changes it while the manager runs.
 *
 * The machine's answer is about room for files, not about memory. It used to
 * be "less than 5 GiB of memory", which caught the container it was meant for
 * and every old laptop and phone with it - machines that write to a disk with
 * plenty of room, and lost their local backups for nothing. Now it is on where
 * files are kept in memory, and where the disk is nearly full.
 */
export class SaverMode {
  private readonly forced: boolean | null;
  private readonly storage: StorageMedium;
  private readonly diskBytes: number | null;
  private readonly memoryBytes: number;
  private choice: boolean | null;

  public constructor(options: SaverModeOptions) {
    this.forced = environmentChoice(options.env ?? process.env);
    this.storage = options.storage ?? ON_DISK;
    this.diskBytes = this.storage.inMemory ? null : options.diskBytes ?? null;
    this.memoryBytes = options.memoryBytes ?? availableMemory();
    this.choice = options.choice;
  }

  public get enabled(): boolean {
    return this.forced ?? this.choice ?? this.reason !== null;
  }

  /** Why the machine would have it on by itself, whoever decided in the end. */
  public get reason(): SaverState['reason'] {
    if (this.storage.inMemory) return 'inMemory';
    return this.diskBytes !== null && this.diskBytes < SAVER_DISK_THRESHOLD_BYTES ? 'lowDisk' : null;
  }

  /** Whether the environment has settled this, so the panel cannot. */
  public get locked(): boolean {
    return this.forced !== null;
  }

  public get source(): SaverSource {
    if (this.forced !== null) return 'environment';
    return this.choice !== null ? 'choice' : 'machine';
  }

  /** Take the panel's switch; the caller stores it. */
  public choose(enabled: boolean): void {
    this.choice = enabled;
  }

  public state(): SaverState {
    return {
      enabled: this.enabled, source: this.source, reason: this.reason, storage: this.storage,
      memoryBytes: this.memoryBytes, diskBytes: this.diskBytes, diskThresholdBytes: SAVER_DISK_THRESHOLD_BYTES,
    };
  }
}

/** `3.8 GiB`, for the log lines that say what the machine is. */
export function formatGibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function environmentChoice(env: NodeJS.ProcessEnv): boolean | null {
  const value = env.STM_SAVER?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return null;
}

/**
 * The memory this process may use.
 *
 * A container reports the host's memory to `totalmem`, which on a hosted
 * studio is a machine many times the size of the slice this runs in. The
 * cgroup limit is the real answer where there is one.
 */
function availableMemory(): number {
  const total = totalmem();
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  return constrained > 0 && constrained < total ? constrained : total;
}
