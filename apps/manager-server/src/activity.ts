import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isR2UsageMode, type AppUsageDay, type AppUsageSummary, type R2UsageMode } from '../../../packages/contracts/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';

const STATE_FILE = 'app-usage.json';
/** Finished days, appended for the telemetry transport to pick up. */
export const APP_USAGE_LOG = 'app-usage.jsonl';
const DAYS_KEPT = 90;

/**
 * How often the meter looks at the clock.
 *
 * Every reading is that long or shorter, so a manager killed without warning
 * loses at most this much of the day it was in the middle of.
 */
export const SAMPLE_INTERVAL_MS = 60_000;

/**
 * The longest gap between two console requests that still counts as somebody
 * being there.
 *
 * The console polls the state it watches every second and a half while
 * something is moving, every fifteen seconds otherwise, and once a minute when
 * the manager has asked it to ease off because the day's Cloudflare Worker
 * allowance is running down. It stops entirely while the page is hidden. A gap
 * longer than this is a page that was closed, hidden, or left on a machine that
 * went to sleep - not a reader.
 *
 * Two minutes, which is the slowest of those clocks with room to spare. It was
 * thirty seconds, from when the slowest clock was eight: a console that had
 * eased to once a minute went on being read and stopped being counted, and the
 * hours-used figure quietly went to zero on exactly the busy account where it
 * was worth having. There is a test in the panel holding these two together.
 *
 * The cost of the larger number is over-counting: a tab closed and reopened
 * within two minutes counts the gap between as attention. That is a handful of
 * seconds on a figure measured in hours, and the wrong way round is worse.
 */
export const CONSOLE_GAP_MS = 120_000;

interface PersistedUsage {
  readonly schemaVersion: 1;
  readonly days: Readonly<Record<string, DayCounts>>;
  /** Days already appended to the log, so a restart does not send one twice. */
  readonly reported: readonly string[];
}

interface DayCounts {
  managerSeconds: number;
  sillyTavernSeconds: number;
  consoleSeconds: number;
  starts: number;
  r2?: R2UsageMode;
}

export interface ActivityMeterOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  /** Whether SillyTavern is up, asked at each sample. */
  readonly sillyTavernRunning?: () => boolean;
  /**
   * How backups to R2 are set up, asked at each sample.
   *
   * The project has no other way to know how many installations keep a copy
   * anywhere but the machine: it holds no account and sees no bucket. The last
   * answer of the day is the one the day keeps.
   */
  readonly r2Mode?: () => Promise<R2UsageMode>;
}

/**
 * How much the manager itself is used.
 *
 * Everything else the manager measures is about SillyTavern: how many requests
 * went to which provider, how many tokens, how long they took. None of it says
 * whether the manager is opened at all - somebody who installed it, set it up
 * once and never came back looks exactly like somebody who never installed it.
 *
 * Three readings, none of which needs the console to send anything it does not
 * already send. The manager's own uptime is the clock. SillyTavern's is asked
 * of the supervisor at each sample. And the console is counted from the
 * requests it makes to watch the machine: those stop while the page is hidden,
 * so what is measured is a console somebody is looking at rather than a tab
 * somebody forgot.
 */
export class ActivityMeter {
  private readonly paths: PlatformPaths;
  private readonly now: () => Date;
  private readonly sillyTavernRunning: () => boolean;
  private readonly r2Mode: (() => Promise<R2UsageMode>) | null;
  private state: PersistedUsage = { schemaVersion: 1, days: {}, reported: [] };
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSampleAt = 0;
  private lastConsoleAt = 0;
  private writing: Promise<void> = Promise.resolve();

  public constructor(options: ActivityMeterOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.sillyTavernRunning = options.sillyTavernRunning ?? (() => false);
    this.r2Mode = options.r2Mode ?? null;
  }

  public async start(): Promise<void> {
    await this.load();
    const today = this.day();
    this.bump(today, (counts) => { counts.starts += 1; });
    this.lastSampleAt = this.now().getTime();
    await this.save();
    this.timer = setInterval(() => { void this.sample(); }, SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  public async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sample();
  }

  /**
   * Somebody is looking at the console.
   *
   * Called from the one request the console makes on a clock. The time since
   * the previous one is counted, up to the point where a gap stops meaning
   * "still watching" - so closing the tab costs at most that gap, and opening
   * it after a week costs nothing.
   */
  public seen(): void {
    const at = this.now().getTime();
    const since = this.lastConsoleAt === 0 ? 0 : at - this.lastConsoleAt;
    this.lastConsoleAt = at;
    if (since <= 0 || since > CONSOLE_GAP_MS) return;
    this.bump(this.day(), (counts) => { counts.consoleSeconds += Math.round(since / 1000); });
  }

  /** Take one reading of the clock, and close off any day that has ended. */
  public async sample(): Promise<void> {
    if (!this.loaded) return;
    const at = this.now().getTime();
    const elapsed = Math.max(0, Math.min(SAMPLE_INTERVAL_MS * 2, at - this.lastSampleAt));
    this.lastSampleAt = at;
    const seconds = Math.round(elapsed / 1000);
    if (seconds > 0) {
      const today = this.day();
      const running = this.sillyTavernRunning();
      this.bump(today, (counts) => {
        counts.managerSeconds += seconds;
        if (running) counts.sillyTavernSeconds += seconds;
      });
    }
    if (this.r2Mode) {
      const mode = await this.r2Mode().catch(() => null);
      if (mode) this.bump(this.day(), (counts) => { counts.r2 = mode; });
    }
    await this.reportFinishedDays();
    await this.save();
  }

  /**
   * What the panel shows, newest day last.
   *
   * A reading is taken first. Without it the manager's own uptime was however
   * much had accrued at the last minute boundary while the console's was
   * counted to the second, so a console opened thirty seconds ago reported
   * more time in front of a manager than the manager had been running.
   */
  public async summary(days = 30): Promise<AppUsageSummary> {
    await this.load();
    await this.sample();
    const from = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = Object.entries(this.state.days)
      .filter(([date]) => date >= from)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, counts]) => ({ schemaVersion: 1 as const, date, ...counts }));
    const totals = rows.reduce((sum, row) => ({
      managerSeconds: sum.managerSeconds + row.managerSeconds,
      sillyTavernSeconds: sum.sillyTavernSeconds + row.sillyTavernSeconds,
      consoleSeconds: sum.consoleSeconds + row.consoleSeconds,
      starts: sum.starts + row.starts,
    }), { managerSeconds: 0, sillyTavernSeconds: 0, consoleSeconds: 0, starts: 0 });
    return { days: rows, totals };
  }

  public get logPath(): string { return join(this.paths.metrics, APP_USAGE_LOG); }

  /**
   * Append every day that has ended and has not been appended before.
   *
   * Only finished days, because a day still being added to would be sent, then
   * sent again with more in it, and a receiver would have to work out which of
   * the two to believe.
   */
  private async reportFinishedDays(): Promise<void> {
    const today = this.day();
    const reported = new Set(this.state.reported);
    const finished = Object.keys(this.state.days).filter((date) => date < today && !reported.has(date)).sort();
    if (finished.length === 0) return;
    const lines = finished.map((date) => {
      const counts = this.state.days[date] ?? { managerSeconds: 0, sillyTavernSeconds: 0, consoleSeconds: 0, starts: 0 };
      const day: AppUsageDay = { schemaVersion: 1, date, ...counts };
      return `${JSON.stringify(day)}\n`;
    }).join('');
    await mkdir(this.paths.metrics, { recursive: true });
    await appendFile(this.logPath, lines, { encoding: 'utf8', mode: 0o600 });
    this.state = { ...this.state, reported: [...reported, ...finished].slice(-DAYS_KEPT) };
  }

  private day(): string { return this.now().toISOString().slice(0, 10); }

  private bump(date: string, change: (counts: DayCounts) => void): void {
    const counts = { ...(this.state.days[date] ?? { managerSeconds: 0, sillyTavernSeconds: 0, consoleSeconds: 0, starts: 0 }) };
    change(counts);
    this.state = { ...this.state, days: { ...this.state.days, [date]: counts } };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, STATE_FILE), 'utf8'));
      this.state = parseUsage(parsed);
    } catch {
      // Absent on a first run, and unreadable is the same as absent: this is a
      // count of how much something was used, not anything anybody depends on.
    }
  }

  private async save(): Promise<void> {
    const operation = async (): Promise<void> => {
      const kept = Object.keys(this.state.days).sort().slice(-DAYS_KEPT);
      const days = Object.fromEntries(kept.map((date) => [date, this.state.days[date] as DayCounts]));
      this.state = { ...this.state, days };
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    };
    const previous = this.writing;
    this.writing = previous.then(operation, operation);
    await this.writing;
  }
}

/** Read a day back, or null when it is not one. */
export function parseUsageDay(value: unknown): AppUsageDay | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(record.date)) return null;
  return {
    schemaVersion: 1,
    date: record.date,
    managerSeconds: seconds(record.managerSeconds),
    sillyTavernSeconds: seconds(record.sillyTavernSeconds),
    consoleSeconds: seconds(record.consoleSeconds),
    starts: seconds(record.starts),
    ...(isR2UsageMode(record.r2) ? { r2: record.r2 } : {}),
  };
}

function parseUsage(value: unknown): PersistedUsage {
  if (typeof value !== 'object' || value === null) throw new Error('not a usage file');
  const record = value as Record<string, unknown>;
  const days: Record<string, DayCounts> = {};
  const stored = typeof record.days === 'object' && record.days !== null ? record.days as Record<string, unknown> : {};
  for (const [date, counts] of Object.entries(stored)) {
    const day = parseUsageDay({ ...(typeof counts === 'object' && counts !== null ? counts : {}), date });
    if (day) days[date] = { managerSeconds: day.managerSeconds, sillyTavernSeconds: day.sillyTavernSeconds, consoleSeconds: day.consoleSeconds, starts: day.starts, ...(day.r2 ? { r2: day.r2 } : {}) };
  }
  const reported = Array.isArray(record.reported) ? record.reported.filter((value): value is string => typeof value === 'string') : [];
  return { schemaVersion: 1, days, reported };
}

/** A whole number of seconds, capped at a day so no reading can be absurd. */
function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), 24 * 60 * 60);
}
