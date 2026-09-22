import { logEvent, type LogSink, type ManagerRelease } from '../../../packages/contracts/src/index.js';
import { MANAGER_VERSION } from './version.js';

/**
 * Whether a newer manager has been published since this one was built.
 *
 * The console already tells a reader when SillyTavern has a new release,
 * because installing SillyTavern is the thing the console does. It said
 * nothing at all about itself: a manager from six months ago went on running
 * quietly, and the only way anybody found out that the version they were on
 * had been replaced was by going to look. A program that installs software for
 * a living should be able to say that it has been superseded.
 *
 * There is deliberately no button here that installs it. The manager is on the
 * machine in one of three shapes - a checkout, a package on npm, a bundle on
 * Windows - and each of them is replaced its own way; a console that tried to
 * overwrite the program it is itself running would be the one upgrade that can
 * leave a machine with neither version. So this reports, names the release,
 * carries what the release said about itself, and links to it.
 */

/** This project, whose releases say which version of the manager is current. */
const REPOSITORY = 'locmaymo/stm';
const GITHUB_API = 'https://api.github.com';

/**
 * How long an answer is trusted before GitHub is asked again.
 *
 * Releases happen on the order of days, and the unauthenticated API counts
 * requests per address - an address that, on a hosted machine, belongs to the
 * platform and is shared with everybody else on it. Six hours is far more
 * often than the thing being watched changes and far less often than the
 * allowance would notice.
 */
const FRESH_FOR_MS = 6 * 60 * 60 * 1000;

/**
 * And how long after a refusal before trying again.
 *
 * Shorter than the interval above, because a rate limit lifts on the hour and
 * a network that was down comes back; long enough that a machine with no route
 * out is not asking every few seconds forever.
 */
const RETRY_AFTER_MS = 30 * 60 * 1000;

/** Longer than a card can show, and the release page holds the rest. */
const MAX_NOTES_CHARACTERS = 1_200;

/** GitHub can take its time; the console's answer must not wait on it. */
const REQUEST_TIMEOUT_MS = 10_000;

interface ReleasePayload {
  readonly tag_name?: unknown;
  readonly name?: unknown;
  readonly body?: unknown;
  readonly html_url?: unknown;
  readonly published_at?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
}

export interface ReleaseWatchOptions {
  /** The version running, which is what anything found is compared against. */
  readonly version?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly logger?: LogSink;
  readonly apiBaseUrl?: string;
  readonly freshForMs?: number;
  readonly retryAfterMs?: number;
}

export class ReleaseWatch {
  private readonly version: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly logger: LogSink | null;
  private readonly apiBaseUrl: string;
  private readonly freshForMs: number;
  private readonly retryAfterMs: number;
  /** The newest release found, whether or not it is newer than this manager. */
  private newest: ManagerRelease | null = null;
  private checkedAt: Date | null = null;
  /** When the next request is allowed, so a refusal is not retried at once. */
  private nextAllowedAt = 0;
  /** The request in flight, so several callers arriving together make one. */
  private inFlight: Promise<void> | null = null;
  /** Said once per failure rather than on every poll that finds it stale. */
  private reportedFailure = false;

  public constructor(options: ReleaseWatchOptions = {}) {
    this.version = options.version ?? MANAGER_VERSION;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? null;
    this.apiBaseUrl = (options.apiBaseUrl ?? GITHUB_API).replace(/\/+$/u, '');
    this.freshForMs = options.freshForMs ?? FRESH_FOR_MS;
    this.retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
  }

  /**
   * What is known right now, without going anywhere.
   *
   * The release is reported only when it is actually newer than what is
   * running. A checkout built from an unreleased commit is ahead of every
   * release there is, and telling somebody on 0.3.0 that 0.2.0 is available
   * would be worse than saying nothing.
   */
  public status(): { readonly version: string; readonly update: ManagerRelease | null; readonly checkedAt: string | null } {
    const newer = this.newest !== null && compareVersions(this.newest.version, this.version) > 0;
    return {
      version: this.version,
      update: newer ? this.newest : null,
      checkedAt: this.checkedAt?.toISOString() ?? null,
    };
  }

  /**
   * Bring that answer up to date, if it is old enough to be worth a request.
   *
   * Never throws and never rejects: a console asking what version it is on has
   * no use for GitHub's problems, and this is called from a route that has an
   * answer to give either way. Callers that do not want to wait do not have to
   * - the answer they miss lands in the one after it.
   */
  public async check(options: { readonly force?: boolean } = {}): Promise<void> {
    const now = this.now().getTime();
    const stale = this.checkedAt === null || now - this.checkedAt.getTime() >= this.freshForMs;
    if (!options.force && !stale) return;
    if (!options.force && now < this.nextAllowedAt) return;
    this.inFlight ??= this.read().finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  private async read(): Promise<void> {
    try {
      const release = await this.newestRelease();
      this.newest = release;
      this.checkedAt = this.now();
      this.nextAllowedAt = 0;
      this.reportedFailure = false;
    } catch (error: unknown) {
      this.nextAllowedAt = this.now().getTime() + this.retryAfterMs;
      if (this.reportedFailure) return;
      this.reportedFailure = true;
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger?.(logEvent(
        'manager.releaseCheckFailed',
        `[manager] the published manager versions could not be read: ${reason}`,
        { reason },
      ));
    }
  }

  private async newestRelease(): Promise<ManagerRelease | null> {
    const response = await this.fetcher(`${this.apiBaseUrl}/repos/${REPOSITORY}/releases?per_page=20`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sillytavern-manager' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status.toString(10)}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('GitHub returned an invalid release list');
    const releases = payload
      .filter(isReleasePayload)
      .filter((release) => release.draft !== true && release.prerelease !== true)
      .map((release) => toRelease(release))
      .filter((release): release is ManagerRelease => release !== null);
    if (releases.length === 0) return null;
    // Newest by version rather than by the order GitHub happened to list them,
    // which is by creation date - and a patch cut against an older branch is
    // published after a release it is behind.
    return releases.reduce((best, release) => compareVersions(release.version, best.version) > 0 ? release : best);
  }
}

function toRelease(payload: ReleasePayload): ManagerRelease | null {
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  if (tag.length === 0) return null;
  const url = typeof payload.html_url === 'string' && payload.html_url.length > 0
    ? payload.html_url
    : `https://github.com/${REPOSITORY}/releases/tag/${tag}`;
  return {
    version: versionOf(tag),
    name: typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : null,
    notes: releaseNotes(typeof payload.body === 'string' ? payload.body : ''),
    url,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
  };
}

/** A tag written the way the manifest writes a version: `v0.2.0` is `0.2.0`. */
export function versionOf(tag: string): string {
  return tag.replace(/^v/iu, '');
}

/**
 * Order two versions the way a reader would: 0.19.0 after 0.9.0.
 *
 * The same rule the installer applies to SillyTavern's tags, for the same
 * reason - a plain string sort puts 0.9 above 0.19 and would have a console
 * announcing an older release as an update. A suffix with no digits in it is
 * ignored rather than guessed at: this compares releases, and a pre-release
 * never reaches here.
 */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string): number[] => (version.match(/\d+/gu) ?? []).map(Number);
  const a = parts(left);
  const b = parts(right);
  if (a.length === 0 || b.length === 0) return (a.length === 0 ? 0 : 1) - (b.length === 0 ? 0 : 1);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The release body, reduced to something a card can show.
 *
 * GitHub's generated notes are Markdown with headings, bullet lists, a wall of
 * commit lines and a compare link at the bottom. What a reader wants off a
 * card is the shape of the change, so the markup is taken off, the automatic
 * trailer is dropped, and the rest is cut at a length that fits - the release
 * page is one click away and has all of it.
 */
export function releaseNotes(body: string): string {
  const text = body
    .replace(/\r\n/gu, '\n')
    // Everything from the generated "what changed" trailer down is a list of
    // commits and a compare link, which says nothing a reader can act on.
    .split(/\n\*\*Full Changelog\*\*/u)[0] ?? '';
  const cleaned = text
    // Images and links keep the words and lose the addresses.
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    // Headings, list markers, quotes and emphasis are markup around the words.
    // Spaces and tabs only, never `\s`: `\s` matches a line ending too, so a
    // blank line before a bullet was being eaten along with the bullet and the
    // paragraph break the author put there disappeared.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gmu, '')
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gmu, '- ')
    .replace(/^[ \t]{0,3}>[ \t]?/gmu, '')
    .replace(/`{1,3}/gu, '')
    .replace(/\*\*|__/gu, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (cleaned.length <= MAX_NOTES_CHARACTERS) return cleaned;
  // Cut at a line ending rather than mid-sentence, so what is shown reads as
  // something somebody wrote rather than as something that ran out.
  const cut = cleaned.slice(0, MAX_NOTES_CHARACTERS);
  const lastBreak = cut.lastIndexOf('\n');
  return `${(lastBreak > MAX_NOTES_CHARACTERS / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}

function isReleasePayload(value: unknown): value is ReleasePayload {
  return typeof value === 'object' && value !== null;
}
