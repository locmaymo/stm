import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import { interpolate, isLogEvent, NOTIFICATION_KINDS, type Job, type LogLine, type ManagerNotification, type MessageParams, type NotificationKind, type NotificationLevel, type NotificationList, type NotificationSummary } from '../../../packages/contracts/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';

const STATE_FILE = 'notifications.json';
/** Enough to scroll back over a busy week; older ones are not news. */
const MAX_KEPT = 100;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export type NotificationLocale = 'en' | 'vi';

/** How a notification is handed to the Android app: a line of output starting with this. */
export const APP_NOTIFICATION_PREFIX = 'STM-NOTIFY ';

/** A notification in words, as a push or the Android app shows it. */
export interface RenderedNotification {
  readonly id: string;
  readonly level: NotificationLevel;
  readonly title: string;
  readonly body: string;
  /** Where a press should go: the broadcast's own link, or the console. */
  readonly url: string | null;
  /** Notifications of one kind replace each other on a phone rather than piling up. */
  readonly tag: string;
}

export interface EmitOptions {
  readonly params?: MessageParams;
  /**
   * Said once per key within `dedupeMs`. Most kinds are things that can
   * happen again and again - a backup failing every tick, a disk that stays
   * full - and a bell that says the same thing forty times is a bell nobody
   * reads.
   */
  readonly dedupeKey?: string;
  readonly dedupeMs?: number;
  readonly broadcast?: ManagerNotification['broadcast'];
}

interface PersistedNotifications {
  readonly schemaVersion: 1;
  readonly items: readonly ManagerNotification[];
  /** When each dedupe key last produced a notification. */
  readonly said: Readonly<Record<string, string>>;
  /** The language the console was last read in, for channels that cannot ask. */
  readonly locale: NotificationLocale;
}

export interface NotificationCenterOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  readonly locale?: NotificationLocale;
}

type Listener = (notification: ManagerNotification) => void;

/**
 * The bell: what happened that the owner would want to know about, kept on
 * the machine and handed to whatever can reach them.
 *
 * Kept in a small file rather than in memory, because the moments worth a
 * notification are exactly the ones around a restart - SillyTavern crashing,
 * an install finishing while nobody watched - and a bell emptied by the
 * restart would have nothing to say about them.
 */
export class NotificationCenter {
  private readonly paths: PlatformPaths;
  private readonly now: () => Date;
  private state: PersistedNotifications;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  public constructor(options: NotificationCenterOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.state = { schemaVersion: 1, items: [], said: {}, locale: options.locale ?? 'en' };
  }

  /** One read, shared: two things happening at once must not each start from an empty bell. */
  public load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        this.state = parseState(JSON.parse(await readFile(join(this.paths.state, STATE_FILE), 'utf8')), this.state.locale);
      } catch {
        // Absent on a first run; unreadable is the same as absent. A bell that
        // starts empty is a smaller loss than a manager that will not start.
      }
    })();
    return this.loading;
  }

  /** Hand every new notification to a channel: web push, the Android app. */
  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public get locale(): NotificationLocale { return this.state.locale; }

  /** Remember the language the console is read in, for a push that cannot ask. */
  public async setLocale(locale: NotificationLocale): Promise<void> {
    await this.load();
    if (this.state.locale === locale) return;
    this.state = { ...this.state, locale };
    await this.save();
  }

  /** Record one, unless the same thing was said too recently. Null when it was not recorded. */
  public async emit(kind: NotificationKind, level: NotificationLevel, options: EmitOptions = {}): Promise<ManagerNotification | null> {
    await this.load();
    const now = this.now();
    if (options.dedupeKey) {
      const last = Date.parse(this.state.said[options.dedupeKey] ?? '');
      if (Number.isFinite(last) && now.getTime() - last < (options.dedupeMs ?? Number.POSITIVE_INFINITY)) return null;
    }
    const notification: ManagerNotification = {
      id: `${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`,
      kind,
      level,
      createdAt: now.toISOString(),
      readAt: null,
      ...(options.params ? { params: options.params } : {}),
      ...(options.broadcast ? { broadcast: options.broadcast } : {}),
    };
    const said = options.dedupeKey ? { ...this.state.said, [options.dedupeKey]: now.toISOString() } : this.state.said;
    this.state = { ...this.state, items: trim([notification, ...this.state.items], now), said: trimSaid(said, now) };
    await this.save();
    for (const listener of this.listeners) {
      try { listener(notification); } catch { /* one channel failing must not stop the others */ }
    }
    return notification;
  }

  public async list(limit = 50): Promise<NotificationList> {
    await this.load();
    return { items: this.state.items.slice(0, limit), unread: this.unreadCount() };
  }

  /** What the console's clock carries. Read from memory once loaded. */
  public summary(): NotificationSummary {
    return { unread: this.unreadCount(), latestId: this.state.items[0]?.id ?? null };
  }

  /** Mark these read, or every one when no ids are given. */
  public async markRead(ids?: readonly string[]): Promise<NotificationSummary> {
    await this.load();
    const at = this.now().toISOString();
    const wanted = ids ? new Set(ids) : null;
    let changed = false;
    const items = this.state.items.map((item) => {
      if (item.readAt || (wanted && !wanted.has(item.id))) return item;
      changed = true;
      return { ...item, readAt: at };
    });
    if (changed) {
      this.state = { ...this.state, items };
      await this.save();
    }
    return this.summary();
  }

  public async clear(): Promise<void> {
    await this.load();
    this.state = { ...this.state, items: [] };
    await this.save();
  }

  private unreadCount(): number {
    return this.state.items.reduce((count, item) => count + (item.readAt ? 0 : 1), 0);
  }

  private async save(): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    };
    const previous = this.writing;
    this.writing = previous.then(operation, operation);
    await this.writing;
  }
}

const CATALOGS: Readonly<Record<NotificationLocale, unknown>> = { en, vi };

/** A notification in one language, for a channel that shows words rather than codes. */
export function renderNotification(notification: ManagerNotification, locale: NotificationLocale): RenderedNotification {
  const base = { id: notification.id, level: notification.level, tag: notification.kind === 'broadcast' ? `broadcast-${notification.id}` : notification.kind };
  if (notification.broadcast) {
    return { ...base, title: notification.broadcast.title[locale] || notification.broadcast.title.en, body: notification.broadcast.body[locale] || notification.broadcast.body.en, url: notification.broadcast.url };
  }
  const params = localizedParams(notification.params, (path) => lookup(CATALOGS[locale], path) ?? lookup(CATALOGS.en, path));
  const words = (field: 'title' | 'body'): string => {
    const template = lookup(CATALOGS[locale], `notify.${notification.kind}.${field}`) ?? lookup(CATALOGS.en, `notify.${notification.kind}.${field}`) ?? '';
    return interpolate(template, params);
  };
  return { ...base, title: words('title'), body: words('body'), url: null };
}

/**
 * Parameters that are codes rather than words - which job, which ceiling -
 * turned into words from `notify.<group>.<code>` before they are put in a
 * sentence. The same rule the console applies, so both say the same thing.
 */
export const NOTIFY_WORD_PARAMS: Readonly<Record<string, string>> = { job: 'notify.jobs', what: 'notify.quota' };

export function localizedParams(params: MessageParams | undefined, find: (path: string) => string | undefined): MessageParams | undefined {
  if (!params) return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    const group = NOTIFY_WORD_PARAMS[key];
    return [key, group ? find(`${group}.${String(value)}`) ?? String(value) : value];
  }));
}

function lookup(catalog: unknown, path: string): string | undefined {
  let current: unknown = catalog;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function trim(items: readonly ManagerNotification[], now: Date): ManagerNotification[] {
  const cutoff = now.getTime() - MAX_AGE_MS;
  return items.filter((item) => Date.parse(item.createdAt) >= cutoff).slice(0, MAX_KEPT);
}

function trimSaid(said: Readonly<Record<string, string>>, now: Date): Record<string, string> {
  // Kept for a year: an update announced once should not come back after a restart.
  const cutoff = now.getTime() - 366 * 24 * 60 * 60 * 1000;
  return Object.fromEntries(Object.entries(said).filter(([, at]) => Date.parse(at) >= cutoff));
}

const LEVELS = new Set<NotificationLevel>(['info', 'success', 'warning', 'error']);

function parseState(value: unknown, locale: NotificationLocale): PersistedNotifications {
  if (typeof value !== 'object' || value === null) throw new Error('not a notifications file');
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.filter(isNotification) : [];
  const said = typeof record.said === 'object' && record.said !== null
    ? Object.fromEntries(Object.entries(record.said as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
  return { schemaVersion: 1, items, said, locale: record.locale === 'vi' || record.locale === 'en' ? record.locale : locale };
}

function isNotification(value: unknown): value is ManagerNotification {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && typeof item.kind === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(item.kind)
    && typeof item.level === 'string' && LEVELS.has(item.level as NotificationLevel)
    && typeof item.createdAt === 'string'
    && (item.readAt === null || typeof item.readAt === 'string');
}

const HOUR = 60 * 60 * 1000;

export interface NotificationRulesDeps {
  readonly center: NotificationCenter;
  /** Whether the tunnel that was on is still meant to be on, and whether it is up. */
  readonly tunnelDown: () => boolean;
  /** Free space where the data is, or null where it cannot be told. */
  readonly freeBytes: () => Promise<{ readonly free: number; readonly total: number } | null>;
  /** How close the bucket is to the ceilings set for it, as fractions; null when there is no bucket. */
  readonly cloudUse: () => Promise<{ readonly storage: number; readonly writes: number; readonly reads: number } | null>;
  /** A SillyTavern release newer than the one installed, or null. */
  readonly sillyTavernUpdate: () => Promise<string | null>;
  /** A manager release newer than this one, or null. */
  readonly managerUpdate: () => Promise<string | null>;
  readonly now?: () => Date;
  /** How long a dropped tunnel may stay down before anybody is told; shortened by tests. */
  readonly tunnelGraceMs?: number;
}

/**
 * What is worth a notification, read off what the manager already says.
 *
 * Nearly everything here is a log line the manager was writing anyway: the
 * code on it says what happened, so the bell does not need a second way of
 * finding out. The rest - space running out, a release appearing - nothing
 * logs, so a slow clock looks.
 */
export class NotificationRules {
  private readonly deps: NotificationRulesDeps;
  private readonly tunnelGraceMs: number;
  private backupFailing = false;
  private tunnelTimer: NodeJS.Timeout | null = null;
  private clock: NodeJS.Timeout | null = null;

  public constructor(deps: NotificationRulesDeps) {
    this.deps = deps;
    this.tunnelGraceMs = deps.tunnelGraceMs ?? 2 * 60 * 1000;
  }

  /** A line the manager wrote. Never throws: logging must not fail because of the bell. */
  public onLog(line: LogLine): void {
    if (!isLogEvent(line)) return;
    const { center } = this.deps;
    const params = line.params ?? {};
    const say = (kind: NotificationKind, level: NotificationLevel, options: EmitOptions = {}): void => { void center.emit(kind, level, { params, ...options }).catch(() => undefined); };
    switch (line.code) {
      case 'sillytavern.exited':
        say('sillytavernCrashed', 'error', { dedupeKey: 'sillytavernCrashed', dedupeMs: 10 * 60 * 1000 });
        break;
      case 'installer.ready':
        say('installFinished', 'success');
        break;
      case 'installer.failed':
        say('installFailed', 'error');
        break;
      case 'backup.scheduleSkipped':
        // The scheduler already says a reason once until it changes; this says
        // it once in six hours at most, however it changes.
        this.backupFailing = true;
        say('backupFailed', 'error', { dedupeKey: 'backupFailed', dedupeMs: 6 * HOUR });
        break;
      case 'backup.scheduledSnapshot':
      case 'backup.r2Synced':
        if (this.backupFailing) {
          this.backupFailing = false;
          say('backupRecovered', 'success', { params: {} });
        }
        break;
      case 'r2.displaced':
        say('bucketTaken', 'warning', { dedupeKey: 'bucketTaken', dedupeMs: HOUR });
        break;
      case 'cloudflared.exited':
        // It usually comes straight back. Somebody is told only when it has not.
        if (this.tunnelTimer) clearTimeout(this.tunnelTimer);
        this.tunnelTimer = setTimeout(() => {
          this.tunnelTimer = null;
          if (this.deps.tunnelDown()) say('tunnelDown', 'warning', { params: {}, dedupeKey: 'tunnelDown', dedupeMs: HOUR });
        }, this.tunnelGraceMs);
        this.tunnelTimer.unref();
        break;
      default:
        break;
    }
  }

  /** A job the owner started finished while they may have been somewhere else. */
  public onJob(job: Job): void {
    if (job.state !== 'succeeded' && job.state !== 'failed') return;
    const { center } = this.deps;
    if (job.kind === 'installation') return;
    if (job.state === 'failed') {
      void center.emit('operationFailed', 'error', { params: { job: job.kind, reason: job.error ?? '' } }).catch(() => undefined);
      return;
    }
    const kind: NotificationKind | null = job.kind === 'backup' ? 'backupDone'
      : job.kind === 'r2Upload' ? 'cloudBackupDone'
        : job.kind === 'restore' ? 'restoreDone'
          : job.kind === 'r2Fetch' ? 'cloudRestoreDone'
            : null;
    if (kind) void center.emit(kind, 'success').catch(() => undefined);
  }

  /** Look at the things nothing logs. Every quarter of an hour; the first look a minute after start. */
  public start(intervalMs = 15 * 60 * 1000): void {
    if (this.clock) return;
    const first = setTimeout(() => { void this.look(); }, 60_000);
    first.unref();
    this.clock = setInterval(() => { void this.look(); }, intervalMs);
    this.clock.unref();
  }

  public close(): void {
    if (this.clock) clearInterval(this.clock);
    if (this.tunnelTimer) clearTimeout(this.tunnelTimer);
    this.clock = null;
    this.tunnelTimer = null;
  }

  /** One look. Public so a test can take it without waiting for the clock. */
  public async look(): Promise<void> {
    const { center } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();
    const month = now.toISOString().slice(0, 7);
    const space = await this.deps.freeBytes().catch(() => null);
    // Under a gigabyte, or under five percent of a small disk: either way,
    // the next backup or install is where it runs out.
    if (space && space.total > 0 && (space.free < 1024 ** 3 || space.free / space.total < 0.05)) {
      await center.emit('diskLow', 'warning', { params: { free: formatSize(space.free) }, dedupeKey: 'diskLow', dedupeMs: 24 * HOUR }).catch(() => null);
    }
    const cloud = await this.deps.cloudUse().catch(() => null);
    if (cloud) {
      const worst = Math.max(cloud.storage, cloud.writes, cloud.reads);
      if (worst >= 0.9) {
        const what = worst === cloud.storage ? 'storage' : worst === cloud.writes ? 'writes' : 'reads';
        await center.emit('cloudQuota', 'warning', { params: { percent: Math.floor(worst * 100), what }, dedupeKey: `cloudQuota:${what}:${month}` }).catch(() => null);
      }
    }
    const sillyTavern = await this.deps.sillyTavernUpdate().catch(() => null);
    if (sillyTavern) await center.emit('sillytavernUpdate', 'info', { params: { version: sillyTavern }, dedupeKey: `sillytavernUpdate:${sillyTavern}` }).catch(() => null);
    const manager = await this.deps.managerUpdate().catch(() => null);
    if (manager) await center.emit('managerUpdate', 'info', { params: { version: manager }, dedupeKey: `managerUpdate:${manager}` }).catch(() => null);
  }
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
