import { KEEP_ONLINE_DEFAULT_MINUTES, KEEP_ONLINE_MAX_MINUTES, KEEP_ONLINE_MIN_MINUTES, logEvent, type LogSink, type OnlineState } from '../../../packages/contracts/src/index.js';

/**
 * Keeping the manager online where being unused is treated as being finished.
 *
 * A process that nobody has asked anything of for a while is a process that
 * can be put to sleep - by the platform it is running on, or by the power
 * management of somebody's own laptop - and SillyTavern goes with it. The
 * reader finds out by opening the address they were given and waiting on a
 * page that never arrives, or finds their chat gone mid-sentence.
 *
 * So the manager reaches its own address on a clock, which is the plainest
 * possible statement that it is still in use. It asks for the health route,
 * which reads nothing, writes nothing and costs one small answer.
 *
 * Which address, in order:
 *
 * 1. What somebody wrote down, in `STM_PUBLIC_ORIGIN` or by running somewhere
 *    that names itself in the environment.
 * 2. The address a browser actually reached this console at. Nobody should
 *    have to set a variable to say what the machine is already being told on
 *    every request - the console knows what to call itself well enough to
 *    offer a link, and this is the same knowledge. Learned from requests that
 *    carry a session, so it is the reader's browser that teaches it and not
 *    whoever can reach the port with a `Host` header of their choosing.
 * 3. This machine's own loopback address. Not a fallback that does nothing: a
 *    battery saver on somebody's own computer is watching whether this process
 *    does anything at all, and loopback answers that.
 *
 * Deliberately never the Worker in front of the tunnel and never the tunnel's
 * own hostname, even when the reader arrived through one: both leave the
 * machine, cross Cloudflare and come back, which spends an allowance that
 * exists for readers on a request no reader made, and neither is the door
 * anything is watching.
 *
 * It does not skip a turn because somebody is reading the console, which is
 * what it used to do on the reasoning that a console being read is already
 * reaching this manager several times a minute. The reasoning is an inference
 * and the inference can be false - the reader may have arrived somewhere other
 * than the address being kept open - and what it produced was a card reporting
 * an address as held that nothing had touched. An answer that is confidently
 * wrong costs more than a request every quarter of an hour.
 */

/*
 * How often the address is reached: `KEEP_ONLINE_DEFAULT_MINUTES`, which is
 * fifteen - often enough for the places that give an idle program half an
 * hour, and rare enough to be four requests an hour against a machine that is
 * not paying attention to them anyway. Somebody whose machine goes quiet
 * sooner than that can say so, within the range beside it.
 */

/** Long enough for a slow link, short enough not to overlap the next one. */
const TIMEOUT_MS = 20_000;

/** The route asked for: it reads nothing, writes nothing and needs no session. */
const HEALTH_PATH = '/api/v1/health';

/**
 * How many failures in a row retire an address that was learned rather than
 * given.
 *
 * A platform that hands out a URL hands out a different one after a redeploy,
 * and the one remembered from before is then somebody else's hostname or
 * nobody's. Three quarters of an hour of no answer is enough to stop sending
 * anything there and go back to loopback; the next console that opens teaches
 * the new address immediately. An address somebody wrote down is never retired
 * - that one is an instruction, not a guess.
 */
const FORGET_AFTER_FAILURES = 3;

export interface OnlineKeeperOptions {
  /**
   * The address somebody wrote down, when they did: `STM_PUBLIC_ORIGIN`, or a
   * platform that names itself in the environment. It outranks everything.
   */
  readonly configuredOrigin: string | null;
  /**
   * The address a browser last reached this console at, as the state file
   * remembers it - so a manager restarted while nobody was looking still knows
   * where it is, which is exactly the machine this exists for.
   */
  readonly seenOrigin?: string | null;
  /** This machine's own loopback address, which is always something to hold. */
  readonly localOrigin: () => string;
  /** Write a newly learned or retired address down, so the next start has it. */
  readonly rememberOrigin?: (origin: string | null) => void;
  /** Whether this is switched on, as the state file had it at startup. */
  readonly enabled: boolean;
  /** How many minutes between attempts, as the state file had it. */
  readonly minutes?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly logger?: LogSink;
}

/** A stored or requested interval, held inside what this will actually do. */
export function intervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return KEEP_ONLINE_DEFAULT_MINUTES;
  return Math.min(KEEP_ONLINE_MAX_MINUTES, Math.max(KEEP_ONLINE_MIN_MINUTES, Math.round(value)));
}

export class OnlineKeeper {
  private readonly configuredOrigin: string | null;
  private readonly localOrigin: () => string;
  private readonly rememberOrigin: (origin: string | null) => void;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly logger: LogSink | null;
  private seenOrigin: string | null;
  private minutes: number;
  private enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastAt: Date | null = null;
  private reachable: boolean | null = null;
  private error: string | null = null;
  /** So a standing failure is said once rather than every few turns. */
  private reported = false;
  /** Failures in a row, which is what retires an address that was learned. */
  private failures = 0;

  public constructor(options: OnlineKeeperOptions) {
    this.configuredOrigin = options.configuredOrigin;
    this.seenOrigin = options.seenOrigin ?? null;
    this.localOrigin = options.localOrigin;
    this.rememberOrigin = options.rememberOrigin ?? (() => undefined);
    this.enabled = options.enabled;
    this.minutes = intervalMinutes(options.minutes);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? null;
  }

  /**
   * A browser reached this console at this address, so it is one that works.
   *
   * Called from the one request the console makes on a clock, which carries a
   * session - so what teaches this is a reader's browser rather than anything
   * that can reach the port. The caller decides what is worth learning: the
   * Worker and the tunnel are addresses a reader genuinely arrives at and are
   * deliberately not among them.
   *
   * A different address replaces the one held. That is a redeploy, or a
   * machine that has moved, and the newest one a browser actually used is the
   * best answer there is.
   */
  public seen(origin: string | null): void {
    if (!origin || origin === this.seenOrigin) return;
    this.seenOrigin = origin;
    this.failures = 0;
    this.reported = false;
    this.rememberOrigin(origin);
  }

  /** The address that will be reached, and where it came from. */
  public target(): { readonly origin: string; readonly source: OnlineState['source'] } {
    if (this.configuredOrigin) return { origin: this.configuredOrigin, source: 'configured' };
    if (this.seenOrigin) return { origin: this.seenOrigin, source: 'seen' };
    return { origin: this.localOrigin(), source: 'local' };
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.minutes * 60_000);
    // The manager is not kept alive by this timer. A process whose only
    // remaining work is holding itself awake has nothing left to be awake for.
    this.timer.unref();
  }

  public close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Turn it on or off and say how often, for a reader who has said which.
   *
   * Switching off forgets what the last attempt found. Leaving "unreachable"
   * standing on a switch that is now off would be reporting a failure of
   * something that is no longer being tried.
   *
   * A changed interval restarts the clock rather than waiting out the one
   * already running: somebody who has just moved this from an hour to five
   * minutes did it because their machine goes quiet sooner than they thought,
   * and making them wait out the hour to find out is the wrong answer.
   */
  public setEnabled(enabled: boolean, minutes = this.minutes): void {
    const next = intervalMinutes(minutes);
    const moved = next !== this.minutes;
    this.minutes = next;
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      this.reachable = null;
      this.error = null;
      this.reported = false;
      if (!enabled) this.lastAt = null;
    }
    if (moved && this.timer) { this.close(); this.start(); }
  }

  public state(): OnlineState {
    const target = this.target();
    return {
      enabled: this.enabled,
      minutes: this.minutes,
      address: this.enabled ? target.origin : null,
      source: target.source,
      status: this.enabled ? (this.reachable === false ? 'unreachable' : 'holding') : 'off',
      lastAt: this.lastAt?.toISOString() ?? null,
      error: this.error,
    };
  }

  /**
   * One turn of the clock. Never throws: nothing waits on this.
   *
   * Public so a test can take a turn without one, and so the server can take
   * the first one as soon as the switch is turned on rather than leaving the
   * reader looking at a card that says nothing until the interval is up.
   */
  public async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    const { origin: address, source } = this.target();
    this.running = true;
    try {
      const response = await this.fetcher(`${address}${HEALTH_PATH}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`the address answered HTTP ${response.status.toString(10)}`);
      // The body is not read for what it says - reaching the address at all is
      // the whole of the point - but it is read so the connection can close
      // rather than being left holding a socket open between turns.
      await response.arrayBuffer().catch(() => undefined);
      this.settle(address, source, true, null);
    } catch (error: unknown) {
      this.settle(address, source, false, reasonFor(error));
    } finally {
      this.running = false;
    }
  }

  private settle(address: string, source: OnlineState['source'], reachable: boolean, error: string | null): void {
    const was = this.reachable;
    this.lastAt = this.now();
    this.reachable = reachable;
    this.error = error;
    this.failures = reachable ? 0 : this.failures + 1;
    if (!reachable && !this.reported) {
      this.reported = true;
      const reason = error ?? 'unknown error';
      this.logger?.(logEvent('online.unreachable', `[manager] this manager could not reach its own address at ${address}: ${reason}`, { address, reason }));
    } else if (reachable && was === false) {
      this.reported = false;
      this.logger?.(logEvent('online.reachable', `[manager] this manager can reach its own address again at ${address}`, { address }));
    }
    /*
     * An address that was learned and has stopped answering is let go.
     *
     * A platform that hands out a URL hands out a different one after a
     * redeploy, and going on sending requests to the old one is sending them
     * to somebody else's hostname. Loopback is what is left until a console
     * opens and teaches the new one, which takes one page load.
     */
    if (source === 'seen' && this.failures >= FORGET_AFTER_FAILURES) {
      this.seenOrigin = null;
      this.failures = 0;
      this.reachable = null;
      this.error = null;
      this.reported = false;
      this.rememberOrigin(null);
      this.logger?.(logEvent('online.forgotten', `[manager] ${address} has not answered for a while, so this manager has stopped treating it as its own address`, { address }));
    }
  }
}

/**
 * Why a request failed, in terms somebody could act on.
 *
 * Node reports every network failure as `fetch failed` and puts the actual
 * reason - the refused connection, the name that does not resolve, the expired
 * certificate - underneath it as the cause. The outer message says only that
 * something went wrong, which the reader already knew from the card.
 */
export function reasonFor(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = error.cause;
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return error.message.length > 0 ? error.message : 'unknown error';
}
