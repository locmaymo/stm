import { open, readFile, stat, unlink } from 'node:fs/promises';
import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import { interpolate, type UsageEvent } from '../../../packages/contracts/src/index.js';
import { isUsageEvent } from '../../../packages/instrumentation/src/index.js';
import type { NotificationLocale } from './notifications.js';
import type { PushMessage } from './web-push.js';

/**
 * Telling somebody who walked away from SillyTavern that a character replied.
 *
 * Two things can say so, and neither is enough alone.
 *
 * SillyTavern's page, through the door, says it best: who replied, what they
 * said, which chat. But only while it runs, and a phone stops a page it is not
 * showing within seconds of the reader leaving it - an iPhone almost at once.
 *
 * SillyTavern's server says it every time: the fetch observer writes a line to
 * the usage log the moment a model's answer ends, whatever the page is doing.
 * But it knows nothing about who or what, and it cannot tell a reply somebody
 * waits for from a request nobody is watching.
 *
 * So the page tells this when it is looked at and when it is left, and when
 * it saw a reply arrive while nobody looked. A reply from the page is told at
 * once, in full. An answer in the usage log is told only when every page that
 * spoke last said it was being left, and the page has not told it already
 * within a few seconds - in a few plain words, because that is all there is.
 * Nobody looking, and no page that ever said otherwise - SillyTavern opened on
 * its own port, past the door - is told nothing: there is no way to know
 * whether somebody is looking at it.
 *
 * On an iPhone the page is stopped before the reply ends nearly every time,
 * so the usage log is what speaks, and plain words were too little. Two
 * things make it say more. The page says who it is waiting for when the
 * message is sent - it is still being looked at then - and the fetch observer
 * puts the start of the finished reply in a file of its own beside the log
 * line, with the same timestamp. Together they are the same notification the
 * page would have sent.
 */

/** How long a page that said it is looked at is believed without hearing from it again. */
const LOOKED_AT_MS = 70_000;
/** How long a page that said it was left still counts as somebody waiting for a reply. */
const AWAY_MS = 60 * 60 * 1000;
/** How long the page is given to say a reply itself, before the usage log says it. */
const GRACE_MS = 4_000;
/** A reply the page told covers an answer in the log this close to it. */
const COVERED_MS = 10_000;
/** The plain words are said at most this often: one reply can be several requests. */
const PLAIN_COOLDOWN_MS = 30_000;
/** How often the usage log is read while somebody is away. */
const POLL_MS = 1_000;
/** As much of a reply as a lock screen is shown. */
const PREVIEW_CHARACTERS = 120;
const MAX_PAGES = 32;

export type PageState = 'visible' | 'hidden' | 'gone';

/** What SillyTavern's page saw: a character finished a reply while nobody looked. */
export interface ReplyReport {
  readonly page: string;
  /** The character's name, or the group's. */
  readonly title: string;
  /** Who spoke, in a group; the same as the title otherwise. */
  readonly name: string;
  readonly group: boolean;
  /** What they said, as it was shown. */
  readonly text: string;
  /** The speaker's avatar file, for SillyTavern's own thumbnail route. */
  readonly avatar: string;
  /** The conversation: `c:` and a character's avatar, or `g:` and a group. */
  readonly key: string;
  /** The chat file. */
  readonly chat: string;
}

export interface ReplyNotifierOptions {
  /** The usage log SillyTavern's fetch observer writes. */
  readonly metricsFile: string;
  /** Where the observer puts the start of the last finished reply; see observer.mjs. */
  readonly replyFile?: string;
  /** Hand a message to every subscribed browser; `preview` is whether that one is shown what was said. */
  readonly deliver: (message: (locale: NotificationLocale, preview: boolean) => PushMessage) => Promise<unknown>;
  readonly now?: () => number;
  readonly graceMs?: number;
  readonly pollMs?: number;
}

interface Page {
  readonly state: Exclude<PageState, 'gone'>;
  readonly at: number;
}

type Outcome = 'ready' | 'cut' | 'failed';

const CATALOGS: Readonly<Record<NotificationLocale, unknown>> = { en, vi };

export class ReplyNotifier {
  private readonly metricsFile: string;
  private readonly replyFile: string | null;
  private readonly deliver: ReplyNotifierOptions['deliver'];
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly pollMs: number;
  private readonly pages = new Map<string, Page>();
  private pending: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  /** Where the usage log was read up to; null while nobody is away and it is not read. */
  private offset: number | null = null;
  private remainder = '';
  private reading = false;
  private toldAt = Number.NEGATIVE_INFINITY;
  private plainAt = Number.NEGATIVE_INFINITY;
  /** Who a page said it is waiting for, and when. */
  private expected: { readonly report: ReplyReport; readonly at: number } | null = null;
  private closed = false;

  public constructor(options: ReplyNotifierOptions) {
    this.metricsFile = options.metricsFile;
    this.replyFile = options.replyFile ?? null;
    this.deliver = options.deliver;
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? GRACE_MS;
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  /** A page said it is looked at, left, or closed. */
  public presence(page: string, state: PageState): void {
    if (this.closed) return;
    if (state === 'gone') this.pages.delete(page);
    else {
      this.pages.delete(page);
      this.pages.set(page, { state, at: this.now() });
      // The oldest go first; a page that never said goodbye is not kept for ever.
      while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value as string);
    }
    // Somebody is looking again: whatever the log was about to say, they can see.
    if (this.lookedAt() && this.pending) { clearTimeout(this.pending); this.pending = null; }
    void this.follow();
  }

  /** A page saw a reply arrive while it was not looked at. */
  public async reply(report: ReplyReport): Promise<void> {
    if (this.closed) return;
    this.presence(report.page, 'hidden');
    if (this.lookedAt()) return;
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    this.toldAt = this.now();
    await this.deliver(about(report, 'ready', preview(report.text)));
  }

  /**
   * A message was sent, and this is who the page is waiting for a reply from.
   * Kept for the usage log to name, should the page be stopped before it can.
   */
  public expect(report: ReplyReport): void {
    if (this.closed) return;
    this.expected = { report, at: this.now() };
  }

  /** One answer from the usage log. Public so a test can hand one over. */
  public answer(event: UsageEvent): void {
    if (this.closed || !this.away()) return;
    if (this.now() - this.toldAt < COVERED_MS) return;
    const outcome: Outcome = event.cut === true ? 'cut' : event.status === null || event.status >= 400 ? 'failed' : 'ready';
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.tellFromLog(event, outcome).catch(() => undefined);
    }, this.graceMs);
    this.pending.unref?.();
  }

  private async tellFromLog(event: UsageEvent, outcome: Outcome): Promise<void> {
    if (this.lookedAt() || this.now() - this.toldAt < COVERED_MS) return;
    if (this.now() - this.plainAt < PLAIN_COOLDOWN_MS) return;
    this.plainAt = this.now();
    const expected = this.expected && this.now() - this.expected.at < AWAY_MS ? this.expected.report : null;
    const said = outcome === 'ready' ? await this.readReply(event.timestamp) : '';
    if (expected) { await this.deliver(about(expected, outcome, preview(said))); return; }
    await this.deliver((locale, shown) => ({
      title: words(locale, `notify.reply.${outcome}.title`),
      body: shown && said ? preview(said) : words(locale, `notify.reply.${outcome}.body`),
      url: '/',
      tag: 'reply',
      level: outcome === 'ready' ? 'info' : 'warning',
    }));
  }

  /**
   * The start of the reply the observer wrote for this answer, and only this
   * one: the timestamp has to be the log line's own. Read once and removed,
   * so the words are not left lying about longer than they are needed.
   */
  private async readReply(timestamp: string): Promise<string> {
    if (!this.replyFile) return '';
    try {
      const parsed = JSON.parse(await readFile(this.replyFile, 'utf8')) as { timestamp?: unknown; text?: unknown };
      if (parsed.timestamp !== timestamp || typeof parsed.text !== 'string') return '';
      await unlink(this.replyFile).catch(() => undefined);
      return parsed.text;
    } catch {
      return '';
    }
  }

  public close(): void {
    this.closed = true;
    if (this.pending) clearTimeout(this.pending);
    if (this.poller) clearInterval(this.poller);
    this.pending = null;
    this.poller = null;
  }

  /** Whether any page said it is being looked at, recently enough to believe. */
  private lookedAt(): boolean {
    const now = this.now();
    for (const page of this.pages.values()) if (page.state === 'visible' && now - page.at < LOOKED_AT_MS) return true;
    return false;
  }

  /** Nobody looking, and a page that said it was left not long ago. */
  private away(): boolean {
    if (this.lookedAt()) return false;
    const now = this.now();
    for (const page of this.pages.values()) if (page.state === 'hidden' && now - page.at < AWAY_MS) return true;
    return false;
  }

  /**
   * Read the usage log while somebody is away, and only then.
   *
   * Reading starts from where the log ends at the moment they left: what was
   * answered while they were looking, they saw.
   */
  private async follow(): Promise<void> {
    if (this.closed) return;
    if (!this.away()) {
      if (this.poller) { clearInterval(this.poller); this.poller = null; }
      this.offset = null;
      this.remainder = '';
      return;
    }
    if (this.offset === null) {
      this.offset = await fileSize(this.metricsFile);
      this.remainder = '';
    }
    if (!this.poller) {
      this.poller = setInterval(() => { void this.read(); }, this.pollMs);
      this.poller.unref?.();
    }
  }

  private async read(): Promise<void> {
    if (this.reading || this.closed) return;
    if (!this.away()) { void this.follow(); return; }
    this.reading = true;
    try {
      const size = await fileSize(this.metricsFile);
      const from = this.offset ?? size;
      // Shorter than where it was read to: replaced or emptied. Start again from its end.
      if (size < from) { this.offset = size; this.remainder = ''; return; }
      if (size === from) return;
      const handle = await open(this.metricsFile, 'r');
      let text: string;
      try {
        const buffer = Buffer.alloc(Math.min(size - from, 1024 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        this.offset = from + bytesRead;
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      const lines = `${this.remainder}${text}`.split('\n');
      this.remainder = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isUsageEvent(parsed)) this.answer(parsed);
        } catch {
          // A line cut short by a write still going on is read whole next time.
        }
      }
    } catch {
      // No log yet, or it went away for a moment: the next tick asks again.
    } finally {
      this.reading = false;
    }
  }
}

/** Where a page may say which state it is in: anything else is not a state. */
export function isPageState(value: unknown): value is PageState {
  return value === 'visible' || value === 'hidden' || value === 'gone';
}

/** A reply as a page sends it, or null when it is not one. Sizes are capped here, whatever the page sent. */
export function parseReplyReport(value: unknown): ReplyReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string, max: number): string => (typeof record[key] === 'string' ? (record[key] as string).slice(0, max) : '');
  const report: ReplyReport = {
    page: text('page', 64),
    title: text('title', 100),
    name: text('name', 100),
    group: record.group === true,
    text: text('text', 1000),
    avatar: text('avatar', 256),
    key: text('key', 300),
    chat: text('chat', 300),
  };
  return report.page && report.title && (report.key.startsWith('c:') || report.key.startsWith('g:')) ? report : null;
}

/**
 * A notification about one conversation: who, what - when this browser is
 * shown what was said and there are words to show - and the chat to open.
 */
function about(report: ReplyReport, outcome: Outcome, text: string): (locale: NotificationLocale, shown: boolean) => PushMessage {
  const url = `/#stm-open=${encodeURIComponent(report.key)}&chat=${encodeURIComponent(report.chat)}`;
  const icon = report.avatar ? `/thumbnail?type=avatar&file=${encodeURIComponent(report.avatar)}` : undefined;
  return (locale, shown) => {
    const named = words(locale, 'notify.reply.named', { name: report.name || report.title });
    const body = outcome !== 'ready' ? words(locale, `notify.reply.${outcome}.body`)
      : shown && text ? (report.group && report.name ? `${report.name}: ${text}` : text)
        : named;
    return { title: report.title, body, url, tag: `reply:${report.key}`, level: outcome === 'ready' ? 'info' : 'warning', ...(icon ? { icon } : {}) };
  };
}

function preview(text: string): string {
  // Asterisks are how a roleplay marks an action; on a lock screen they are noise.
  const flat = text.replace(/\*+/gu, '').replace(/\s+/gu, ' ').trim();
  return flat.length <= PREVIEW_CHARACTERS ? flat : `${flat.slice(0, PREVIEW_CHARACTERS - 1).trimEnd()}…`;
}

function words(locale: NotificationLocale, path: string, params?: Record<string, string>): string {
  const template = lookup(CATALOGS[locale], path) ?? lookup(CATALOGS.en, path) ?? '';
  return params ? interpolate(template, params) : template;
}

function lookup(catalog: unknown, path: string): string | undefined {
  let current: unknown = catalog;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}
