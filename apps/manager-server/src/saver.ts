import { totalmem } from 'node:os';
import type { SaverSource, SaverState } from '../../../packages/contracts/src/index.js';

/**
 * Below this much memory, saver mode is on unless somebody says otherwise.
 *
 * Five gibibytes, because the hosts this is for hand a container about four
 * for memory and disk together, and an ordinary computer has more than five.
 */
export const SAVER_MEMORY_THRESHOLD_BYTES = 5 * 1024 ** 3;

export interface SaverModeOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** The panel's stored choice, or null when nobody has made one. */
  readonly choice: boolean | null;
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
 * override; the panel's switch when it has been pressed; otherwise how much
 * memory the machine has. The panel's switch then changes it while the
 * manager runs.
 */
export class SaverMode {
  private readonly forced: boolean | null;
  private readonly memoryBytes: number;
  private choice: boolean | null;

  public constructor(options: SaverModeOptions) {
    this.forced = environmentChoice(options.env ?? process.env);
    this.memoryBytes = options.memoryBytes ?? availableMemory();
    this.choice = options.choice;
  }

  public get enabled(): boolean {
    return this.forced ?? this.choice ?? this.memoryBytes < SAVER_MEMORY_THRESHOLD_BYTES;
  }

  /** Whether the environment has settled this, so the panel cannot. */
  public get locked(): boolean {
    return this.forced !== null;
  }

  public get source(): SaverSource {
    if (this.forced !== null) return 'environment';
    return this.choice !== null ? 'choice' : 'memory';
  }

  /** Take the panel's switch; the caller stores it. */
  public choose(enabled: boolean): void {
    this.choice = enabled;
  }

  public state(): SaverState {
    return { enabled: this.enabled, source: this.source, memoryBytes: this.memoryBytes, thresholdBytes: SAVER_MEMORY_THRESHOLD_BYTES };
  }
}

/** `3.8 GiB`, for the log line that says why saver mode is on. */
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
