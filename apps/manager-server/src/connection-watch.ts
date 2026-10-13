import { open, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionTarget, ConnectionTestResult, ConnectionWatchSettings, MessageParams, NotificationKind } from '../../../packages/contracts/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';

/**
 * Keeping an eye on the keys and proxies, so a reply that fails is explained
 * before anyone has to ask why.
 *
 * Two watches, each its own switch:
 *
 * - A daily test of every key and proxy, off until it is turned on: it calls
 *   each provider with the user's own keys. Afterwards the bell says what got
 *   worse since the last test - a key the provider now refuses, an account
 *   out of credit or below the line the user set, a proxy that stopped
 *   answering. What stayed the same is not said again.
 * - Refusals in SillyTavern's own traffic, read from the metrics file as it
 *   grows: a run of 401s or 429s from one provider within ten minutes gets a
 *   hint with a link to test it now. It reads only what is already on this
 *   machine, so it is on unless turned off.
 *
 * Nothing from a chat is read or said: the metrics carry the provider, the
 * status and the time, and a key is named by the label the user gave it.
 */

const SETTINGS_FILE = 'connection-watch.json';
/** How often the watcher looks; the daily test runs on the first look a day after the last. */
export const WATCH_TICK_MS = 60_000;
export const DAILY_MS = 24 * 60 * 60 * 1000;
/** Refusals counted together. */
export const BURST_WINDOW_MS = 10 * 60 * 1000;
/** How many refusals in the window make a run worth a hint. */
export const BURST_MIN = 5;
/** A hint about one provider at most once an hour. */
const BURST_DEDUPE_MS = 60 * 60 * 1000;
/** How much of the metrics file a fresh start reads back, for refusals just before it. */
const TAIL_START_BYTES = 256 * 1024;
/** More than this is read in pieces over several looks. */
const TAIL_MAX_BYTES = 4 * 1024 * 1024;

export const DEFAULT_WATCH_SETTINGS: ConnectionWatchSettings = { daily: false, creditThreshold: null, errorHints: true, lastRunAt: null };

/** Something the bell should say. */
export interface WatchFinding {
  readonly kind: NotificationKind;
  readonly level: 'warning' | 'error';
  readonly params: MessageParams;
  readonly dedupeKey: string;
  readonly dedupeMs: number;
}

/** One target's test, with the one before it. */
export interface TestedTarget {
  readonly target: ConnectionTarget;
  /** What the bell calls it: a key's label with its provider, a proxy's name. */
  readonly name: string;
  readonly previous: ConnectionTestResult | null;
  readonly result: ConnectionTestResult;
}

/**
 * What got worse between two tests of one target.
 *
 * Only a change is told: a key refused today and yesterday was told about
 * yesterday. The dedupe keys stop a key that flips back and forth from
 * ringing every day.
 */
export function watchFindings(tested: TestedTarget, creditThreshold: number | null): WatchFinding[] {
  const { target, name, previous, result } = tested;
  const id = target.kind === 'key' ? `${target.secretKey}:${target.id ?? ''}` : target.kind === 'proxy' ? `proxy:${target.name}` : `profile:${target.id}`;
  const week = 7 * DAILY_MS;
  if (target.kind === 'proxy') {
    const down = result.code === 'unreachable' || result.code === 'proxy_auth' || result.code === 'bad_url';
    return down && previous?.code === 'ok'
      ? [{ kind: 'connectionProxyDown', level: 'warning', params: { name, problem: result.code }, dedupeKey: `connectionProxyDown:${id}`, dedupeMs: DAILY_MS }]
      : [];
  }
  if (result.code === 'invalid_key' && previous?.code !== 'invalid_key') {
    return [{ kind: 'connectionKeyInvalid', level: 'error', params: { name }, dedupeKey: `connectionKeyInvalid:${id}`, dedupeMs: week }];
  }
  if (result.code === 'no_credit' && previous?.code !== 'no_credit') {
    return [{ kind: 'connectionNoCredit', level: 'error', params: { name }, dedupeKey: `connectionNoCredit:${id}`, dedupeMs: week }];
  }
  const balance = result.balance;
  if (result.code === 'ok' && balance && creditThreshold !== null && balance.amount < creditThreshold) {
    const wasBelow = previous?.balance ? previous.balance.amount < creditThreshold : false;
    if (!wasBelow) {
      return [{ kind: 'connectionLowCredit', level: 'warning', params: { name, amount: formatAmount(balance.amount, balance.currency), threshold: formatAmount(creditThreshold, balance.currency) }, dedupeKey: `connectionLowCredit:${id}`, dedupeMs: 3 * DAILY_MS }];
    }
  }
  return [];
}

/** A refusal as the metrics file records it. */
export interface Refusal {
  readonly at: number;
  readonly provider: string;
  readonly status: number;
}

/**
 * Runs of refusals worth a hint: at least `BURST_MIN` of one kind from one
 * provider in the last ten minutes. A 401 or 403 says the key is wrong or
 * gone; a 429 that it is asked too often, or out of quota.
 */
export function errorBursts(refusals: readonly Refusal[], now: number): WatchFinding[] {
  const counts = new Map<string, { provider: string; kind: 'auth' | 'rate'; count: number }>();
  for (const refusal of refusals) {
    if (now - refusal.at > BURST_WINDOW_MS || refusal.at > now) continue;
    const kind = refusal.status === 429 ? 'rate' : refusal.status === 401 || refusal.status === 403 ? 'auth' : null;
    if (!kind) continue;
    const key = `${refusal.provider}:${kind}`;
    const entry = counts.get(key) ?? { provider: refusal.provider, kind, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].filter((entry) => entry.count >= BURST_MIN).map((entry) => ({
    kind: entry.kind === 'auth' ? 'connectionRefused' : 'connectionRateLimited',
    level: 'warning',
    params: { provider: metricsProviderName(entry.provider), count: entry.count, minutes: BURST_WINDOW_MS / 60_000 },
    dedupeKey: `connectionBurst:${entry.provider}:${entry.kind}`,
    dedupeMs: BURST_DEDUPE_MS,
  }));
}

/** The metrics file names official hosts by provider and others by host. */
export function metricsProviderName(provider: string): string {
  const names: Readonly<Record<string, string>> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };
  if (names[provider]) return names[provider];
  if (provider === 'openrouter.ai') return 'OpenRouter';
  return provider;
}

/**
 * The metrics file read as it grows, from where the last read stopped.
 *
 * SillyTavern's loader appends one line per request; only refusals are kept,
 * and only for the window. A file that got shorter was rewritten, so it is
 * read again from its start.
 */
export class MetricsTail {
  private offset: number | null = null;
  private partial = '';
  private refusals: Refusal[] = [];

  public constructor(private readonly file: string) {}

  public async read(now: number): Promise<readonly Refusal[]> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.file, 'r');
      const size = (await handle.stat()).size;
      if (this.offset === null) this.offset = Math.max(0, size - TAIL_START_BYTES);
      if (size < this.offset) { this.offset = 0; this.partial = ''; }
      const length = Math.min(size - this.offset, TAIL_MAX_BYTES);
      if (length > 0) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        this.offset += bytesRead;
        const text = this.partial + buffer.subarray(0, bytesRead).toString('utf8');
        const lines = text.split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) {
          const refusal = refusalOf(line);
          if (refusal) this.refusals.push(refusal);
        }
      }
    } catch {
      // No metrics yet, or a file being replaced: nothing to read this time.
    } finally {
      await handle?.close().catch(() => undefined);
    }
    this.refusals = this.refusals.filter((refusal) => now - refusal.at <= BURST_WINDOW_MS);
    return this.refusals;
  }
}

function refusalOf(line: string): Refusal | null {
  if (line.length > 16 * 1024 || !line.includes('"status"')) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const at = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
    const status = parsed.status;
    if (!Number.isFinite(at) || typeof parsed.provider !== 'string' || (status !== 401 && status !== 403 && status !== 429)) return null;
    return { at, provider: parsed.provider, status };
  } catch {
    // A line half written by an append that is still going.
    return null;
  }
}

/** The watch's switches, kept in the manager's state folder. */
export class ConnectionWatchStore {
  private readonly file: string;
  private cache: ConnectionWatchSettings | null = null;
  private writing: Promise<void> = Promise.resolve();

  public constructor(paths: PlatformPaths) {
    this.file = join(paths.state, SETTINGS_FILE);
  }

  public async get(): Promise<ConnectionWatchSettings> {
    if (this.cache) return this.cache;
    let read = DEFAULT_WATCH_SETTINGS;
    try {
      read = parseWatchSettings(JSON.parse(await readFile(this.file, 'utf8'))) ?? DEFAULT_WATCH_SETTINGS;
    } catch { /* not set yet */ }
    this.cache ??= read;
    return this.cache;
  }

  public async update(change: Partial<ConnectionWatchSettings>): Promise<ConnectionWatchSettings> {
    await this.get();
    const next: ConnectionWatchSettings = { ...DEFAULT_WATCH_SETTINGS, ...this.cache, ...change };
    this.cache = next;
    this.writing = this.writing.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...next }), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    }).catch(() => undefined);
    await this.writing;
    return next;
  }
}

/** The settings in a request or a file, if they are settings. */
export function parseWatchSettings(value: unknown): ConnectionWatchSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const threshold = record.creditThreshold;
  return {
    daily: record.daily === true,
    creditThreshold: typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 ? threshold : null,
    errorHints: record.errorHints !== false,
    lastRunAt: typeof record.lastRunAt === 'string' && Number.isFinite(Date.parse(record.lastRunAt)) ? record.lastRunAt : null,
  };
}

export interface ConnectionWatcherOptions {
  readonly store: ConnectionWatchStore;
  /** Test every key and proxy; null when there is nothing to test. */
  readonly testAll: () => Promise<readonly TestedTarget[] | null>;
  readonly tail: MetricsTail;
  readonly notify: (finding: WatchFinding) => Promise<void>;
  readonly now?: () => number;
  readonly tickMs?: number;
}

/** The two watches, on one timer. */
export class ConnectionWatcher {
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;
  private running: Promise<void> | null = null;

  public constructor(private readonly options: ConnectionWatcherOptions) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => { void this.tick(); }, options.tickMs ?? WATCH_TICK_MS);
    this.timer.unref();
  }

  public close(): void {
    clearInterval(this.timer);
  }

  /** One look; a look still going when the next is due is not started twice. */
  public tick(): Promise<void> {
    this.running ??= this.look().finally(() => { this.running = null; });
    return this.running;
  }

  private async look(): Promise<void> {
    const settings = await this.options.store.get();
    const now = this.now();
    if (settings.errorHints) {
      for (const finding of errorBursts(await this.options.tail.read(now), now)) await this.options.notify(finding);
    }
    const last = settings.lastRunAt ? Date.parse(settings.lastRunAt) : Number.NEGATIVE_INFINITY;
    if (!settings.daily || now - last < DAILY_MS) return;
    // Marked first, so a test that keeps failing is not retried every minute.
    await this.options.store.update({ lastRunAt: new Date(now).toISOString() });
    const tested = await this.options.testAll().catch(() => null);
    for (const item of tested ?? []) {
      for (const finding of watchFindings(item, settings.creditThreshold)) await this.options.notify(finding);
    }
  }
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
