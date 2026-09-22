import { KEEP_ONLINE_DEFAULT_MINUTES, KEEP_ONLINE_MAX_MINUTES, KEEP_ONLINE_MIN_MINUTES, logEvent, type LogSink, type OnlineState } from '../../../packages/contracts/src/index.js';

/**
 * Keeping the manager online where being unused is treated as being finished.
 *
 * On somebody's own computer this does nothing and is not needed: the program
 * runs until it is stopped. Elsewhere - anywhere the manager is running on a
 * machine somebody else operates - a process that nobody has asked anything of
 * for a while is a process that can be put to sleep, and SillyTavern then goes
 * with it. The reader finds out by opening the address they were given and
 * waiting on a page that never arrives, or finds their chat gone mid-sentence.
 *
 * So the manager reaches its own address on a clock, which is the plainest
 * possible statement that it is still in use. It asks for the health route,
 * which reads nothing, writes nothing and costs one small answer.
 *
 * The address is the machine's own - what the platform serves this manager at,
 * or whatever `STM_PUBLIC_ORIGIN` names. Deliberately not the Worker in front
 * of the tunnel and not the tunnel's own hostname: both of those leave the
 * machine, cross Cloudflare and come back, which spends an allowance that
 * exists for readers on a request no reader made, and neither is the door the
 * platform is watching. A manager with no address of its own does nothing at
 * all.
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

export interface OnlineKeeperOptions {
  /**
   * This machine's own address from outside, or null when it has none.
   *
   * Settled once, from the environment, so it is a value rather than something
   * to ask again: a tunnel coming up does not change what the platform serves
   * this manager at, and the tunnel is not what is kept open here.
   */
  readonly origin: string | null;
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
  private readonly origin: string | null;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly logger: LogSink | null;
  private minutes: number;
  private enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastAt: Date | null = null;
  private reachable: boolean | null = null;
  private error: string | null = null;
  /** So a standing failure is said once rather than every few turns. */
  private reported = false;

  public constructor(options: OnlineKeeperOptions) {
    this.origin = options.origin;
    this.enabled = options.enabled;
    this.minutes = intervalMinutes(options.minutes);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? null;
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
    return {
      enabled: this.enabled,
      minutes: this.minutes,
      address: this.enabled ? this.origin : null,
      status: this.status(),
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
    const address = this.origin;
    if (!address) return;
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
      this.settle(true, null);
    } catch (error: unknown) {
      this.settle(false, reasonFor(error));
    } finally {
      this.running = false;
    }
  }

  private settle(reachable: boolean, error: string | null): void {
    const was = this.reachable;
    this.lastAt = this.now();
    this.reachable = reachable;
    this.error = error;
    if (!reachable && !this.reported) {
      this.reported = true;
      const reason = error ?? 'unknown error';
      this.logger?.(logEvent('online.unreachable', `[manager] this manager could not reach its own address at ${this.origin ?? 'nowhere'}: ${reason}`, { address: this.origin ?? '', reason }));
      return;
    }
    if (reachable && was === false) {
      this.reported = false;
      this.logger?.(logEvent('online.reachable', `[manager] this manager can reach its own address again at ${this.origin ?? 'nowhere'}`, { address: this.origin ?? '' }));
    }
  }

  private status(): OnlineState['status'] {
    if (!this.enabled) return 'off';
    if (!this.origin) return 'no_address';
    if (this.reachable === false) return 'unreachable';
    return 'holding';
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
