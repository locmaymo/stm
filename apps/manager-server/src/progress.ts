import { formatBytes, type MessageParams, type TransferProgress } from '../../../packages/contracts/src/index.js';

/**
 * How much history the rate is averaged over.
 *
 * An instant rate taken between two files swings between zero and the speed of
 * a local disk, which is useless to read. Averaging over the whole transfer
 * instead makes the estimate stop reacting to anything once it is minutes in.
 * A few seconds of history is the middle: steady enough to read, quick enough
 * to notice a connection that has slowed down.
 */
const WINDOW_MS = 10_000;
/** Below this there is not enough history for a rate to mean anything. */
const MINIMUM_SAMPLE_MS = 750;

interface Sample {
  readonly at: number;
  readonly bytes: number;
}

/**
 * Turns bytes transferred into the two things someone waiting actually wants:
 * how fast it is going, and how much longer.
 *
 * A first upload of a profile is gigabytes and takes many minutes. Without
 * this it is an indeterminate bar, which looks the same as a hang - and the
 * reasonable response to something that looks hung is to kill it, which is the
 * one thing that makes it take longer.
 */
export class TransferMeter {
  private readonly now: () => number;
  private readonly samples: Sample[] = [];

  public constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.samples.push({ at: this.now(), bytes: 0 });
  }

  /** Record where the transfer has got to, and describe it. */
  public update(progress: TransferProgress): { percent: number; params: MessageParams } {
    const at = this.now();
    this.samples.push({ at, bytes: progress.completedBytes });
    while (this.samples.length > 2 && at - (this.samples[0]?.at ?? at) > WINDOW_MS) this.samples.shift();
    const oldest = this.samples[0];
    const span = oldest ? at - oldest.at : 0;
    const moved = oldest ? progress.completedBytes - oldest.bytes : 0;
    const bytesPerSecond = span >= MINIMUM_SAMPLE_MS && moved > 0 ? (moved / span) * 1000 : 0;
    const remaining = Math.max(0, progress.totalBytes - progress.completedBytes);
    return {
      percent: progress.totalBytes > 0 ? Math.min(100, (progress.completedBytes / progress.totalBytes) * 100) : 0,
      params: {
        done: formatBytes(progress.completedBytes),
        total: formatBytes(progress.totalBytes),
        // Zero means "not known yet" rather than "stopped", so it is shown as
        // a dash instead of a confident 0 B/s.
        rate: bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—',
        eta: bytesPerSecond > 0 ? formatDuration(remaining / bytesPerSecond) : '—',
        completed: progress.completedItems,
        files: progress.totalItems,
      },
    };
  }
}

/**
 * A duration as digits rather than words, because the words would need
 * translating and the digits read the same in every language.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
