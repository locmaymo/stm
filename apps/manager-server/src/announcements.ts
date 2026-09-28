import type { NotificationCenter } from './notifications.js';

/** Where the project's announcements are read from. `STM_ANNOUNCEMENTS_URL` moves it; empty turns it off. */
export const DEFAULT_ANNOUNCEMENTS_URL = 'https://stm-telemetry.locmaymo.top/v1/announcements';

const FIRST_LOOK_MS = 2 * 60 * 1000;
const INTERVAL_MS = 3 * 60 * 60 * 1000;

interface Announcement {
  readonly id: string;
  readonly level: 'info' | 'warning';
  readonly title: { readonly en: string; readonly vi: string };
  readonly body: { readonly en: string; readonly vi: string };
  readonly url: string | null;
}

export interface AnnouncementFeedOptions {
  readonly center: NotificationCenter;
  readonly url: string;
  readonly platform: string;
  readonly version: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * News from the project, in the bell.
 *
 * Asked for, a few times a day, the way a release check is: the request
 * carries the platform and the version so the answer can be aimed, and
 * nothing else - no installation id, nothing that says which machine asked.
 * Each announcement is shown once, however many times it is read back.
 */
export class AnnouncementFeed {
  private readonly options: AnnouncementFeedOptions;
  private readonly fetcher: typeof globalThis.fetch;
  private timers: NodeJS.Timeout[] = [];

  public constructor(options: AnnouncementFeedOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  public start(): void {
    if (this.timers.length) return;
    const first = setTimeout(() => { void this.check(); }, FIRST_LOOK_MS);
    const clock = setInterval(() => { void this.check(); }, INTERVAL_MS);
    first.unref();
    clock.unref();
    this.timers = [first, clock];
  }

  public close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** One look. Never throws: news that cannot be read is news for later. */
  public async check(): Promise<number> {
    let body: unknown;
    try {
      const query = new URLSearchParams({ platform: this.options.platform, version: this.options.version });
      const response = await this.fetcher(`${this.options.url}?${query.toString()}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return 0;
      body = await response.json();
    } catch {
      return 0;
    }
    const list = typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>).announcements)
      ? ((body as Record<string, unknown>).announcements as unknown[]).filter(isAnnouncement)
      : [];
    let shown = 0;
    // Oldest first, so the newest ends up on top of the bell.
    for (const item of [...list].reverse()) {
      const said = await this.options.center.emit('broadcast', item.level, {
        broadcast: { title: item.title, body: item.body, url: item.url },
        dedupeKey: `broadcast:${item.id}`,
      }).catch(() => null);
      if (said) shown += 1;
    }
    return shown;
  }
}

function words(value: unknown, max: number): value is { en: string; vi: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.en === 'string' && typeof record.vi === 'string' && record.en.length > 0 && record.en.length <= max && record.vi.length <= max;
}

function isAnnouncement(value: unknown): value is Announcement {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(item.id)
    && (item.level === 'info' || item.level === 'warning')
    && words(item.title, 120)
    && words(item.body, 1000)
    && (item.url === null || (typeof item.url === 'string' && /^https:\/\/\S+$/u.test(item.url) && item.url.length <= 500));
}
