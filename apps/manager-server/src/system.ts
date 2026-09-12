import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { readFile, readdir, statfs } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SystemSnapshot } from '../../../packages/contracts/src/index.js';
import { createIoLimiter, ioConcurrency } from '../../../packages/platform/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';

/**
 * How long a measured directory size is served before it is taken again.
 *
 * Sizing a profile means stat-ing every file in it, which on a hosted volume
 * costs seconds. That is far too slow to do on each poll of a dashboard, and
 * the number barely moves between chats, so it is measured in the background
 * and served from the last result.
 */
const SIZE_TTL_MS = 5 * 60 * 1000;
const EXCLUDED_FROM_SIZE = new Set(['.git', 'node_modules']);

interface CpuSample {
  readonly idle: number;
  readonly total: number;
}

interface MeasuredSize {
  readonly bytes: number;
  readonly fileCount: number;
  readonly measuredAt: string;
}

export interface SystemStoreOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  /** The running SillyTavern process, when there is one. */
  readonly childPid?: () => number | null;
  /** The active profile's user-data directory, when a profile is active. */
  readonly dataRoot?: () => Promise<string | null>;
}

export class SystemStore {
  private readonly paths: PlatformPaths;
  private readonly now: () => Date;
  private readonly childPid: () => number | null;
  private readonly dataRoot: () => Promise<string | null>;
  private lastCpu: CpuSample | null = null;
  private managerSize: MeasuredSize | null = null;
  private dataSize: MeasuredSize | null = null;
  private measuring = false;

  public constructor(options: SystemStoreOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.childPid = options.childPid ?? (() => null);
    this.dataRoot = options.dataRoot ?? (async () => null);
  }

  public async snapshot(): Promise<SystemSnapshot> {
    const [storage, sillytavernRssBytes] = await Promise.all([this.readStorage(), this.readChildRss()]);
    const totalBytes = totalmem();
    const freeBytes = freemem();
    this.scheduleSizeRefresh();
    return {
      generatedAt: this.now().toISOString(),
      cpu: {
        cores: cpus().length,
        usagePercent: this.readCpuUsage(),
        loadAverage: loadavg().map((value) => Math.round(value * 100) / 100),
      },
      memory: {
        totalBytes,
        freeBytes,
        usedBytes: totalBytes - freeBytes,
        managerBytes: process.memoryUsage.rss(),
        sillytavernBytes: sillytavernRssBytes,
      },
      storage: {
        root: this.paths.root,
        ...storage,
        managerBytes: this.managerSize?.bytes ?? null,
        dataBytes: this.dataSize?.bytes ?? null,
        dataFileCount: this.dataSize?.fileCount ?? null,
        measuredAt: this.dataSize?.measuredAt ?? this.managerSize?.measuredAt ?? null,
      },
    };
  }

  /**
   * Percentage of CPU time spent out of idle since the previous call.
   *
   * `os.cpus()` reports totals since boot, so a single reading says nothing
   * about now; the first call establishes the baseline and returns null.
   */
  private readCpuUsage(): number | null {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    const previous = this.lastCpu;
    this.lastCpu = { idle, total };
    if (!previous) return null;
    const totalDelta = total - previous.total;
    const idleDelta = idle - previous.idle;
    if (totalDelta <= 0) return null;
    return Math.round(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) * 10) / 10;
  }

  private async readStorage(): Promise<{ totalBytes: number | null; freeBytes: number | null }> {
    try {
      const details = await statfs(this.paths.root);
      return { totalBytes: details.blocks * details.bsize, freeBytes: details.bavail * details.bsize };
    } catch {
      // A volume that refuses statfs still leaves every other reading useful.
      return { totalBytes: null, freeBytes: null };
    }
  }

  /** Resident memory of the SillyTavern child, read from procfs where there is one. */
  private async readChildRss(): Promise<number | null> {
    const pid = this.childPid();
    if (pid === null || process.platform !== 'linux') return null;
    try {
      const statm = await readFile(`/proc/${pid}/statm`, 'utf8');
      const pages = Number(statm.split(' ')[1]);
      return Number.isSafeInteger(pages) ? pages * 4096 : null;
    } catch {
      return null;
    }
  }

  private scheduleSizeRefresh(): void {
    if (this.measuring) return;
    const measuredAt = this.dataSize?.measuredAt ?? this.managerSize?.measuredAt;
    if (measuredAt && this.now().getTime() - Date.parse(measuredAt) < SIZE_TTL_MS) return;
    this.measuring = true;
    void (async () => {
      try {
        const limiter = createIoLimiter(ioConcurrency());
        const root = await this.dataRoot();
        const [manager, data] = await Promise.all([
          measureTree(this.paths.root, limiter),
          root ? measureTree(root, limiter) : Promise.resolve({ bytes: 0, fileCount: 0 }),
        ]);
        const stamp = this.now().toISOString();
        this.managerSize = { ...manager, measuredAt: stamp };
        this.dataSize = root ? { ...data, measuredAt: stamp } : null;
      } catch {
        // Keep the previous reading; the next poll asks again.
      } finally {
        this.measuring = false;
      }
    })();
  }
}

async function measureTree(root: string, limiter: { run: <R>(operation: () => Promise<R>) => Promise<R> }): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0;
  let fileCount = 0;
  const visit = async (current: string): Promise<void> => {
    let children;
    try {
      children = await limiter.run(() => readdir(current, { withFileTypes: true }));
    } catch {
      return;
    }
    await Promise.all(children.map(async (child) => {
      if (EXCLUDED_FROM_SIZE.has(child.name)) return;
      const full = join(current, child.name);
      if (child.isSymbolicLink()) return;
      if (child.isDirectory()) { await visit(full); return; }
      try {
        const details = await limiter.run(() => lstat(full));
        bytes += details.size;
        fileCount += 1;
      } catch {
        // A file removed while walking simply does not count.
      }
    }));
  };
  await visit(root);
  return { bytes, fileCount };
}
