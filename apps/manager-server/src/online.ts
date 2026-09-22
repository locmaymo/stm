import { logEvent, type LogSink, type OnlineState } from '../../../packages/contracts/src/index.js';

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
 * So the manager reaches its own outside address on a clock, which is the
 * plainest possible statement that it is still in use. It asks for the health
 * route, which reads nothing, writes nothing and costs one small answer.
 *
 * A manager with no outside address does nothing at all, which is every
 * manager reachable only from the computer it runs on.
 *
 * It does not skip a turn because somebody is reading the console, which is
 * what it used to do on the reasoning that a console being read is already
 * reaching this manager several times a minute. The reasoning is an inference
 * and the inference can be false - the reader may have arrived at the local
 * address while the one that needs keeping open is a tunnel - and what it
 * produced was a card reporting an address as held that nothing had touched.
 * A request every four minutes is a rounding error against any allowance
 * worth counting; an answer that is confidently wrong is not.
 */

/**
 * How often the address is reached.
 *
 * Under five minutes, which is the shortest of the intervals this has to stay
 * inside, and far enough under it that one refused attempt does not put the
 * manager over. It is a handful of small requests an hour.
 */
const INTERVAL_MS = 4 * 60 * 1000;

/** Long enough for a slow link, short enough not to overlap the next one. */
const TIMEOUT_MS = 20_000;

/** The route asked for: it reads nothing, writes nothing and needs no session. */
const HEALTH_PATH = '/api/v1/health';

export interface OnlineKeeperOptions {
  /** Every address this manager answers on from outside, best first. */
  readonly addresses: () => readonly string[];
  /** Whether this is switched on, as the state file had it at startup. */
  readonly enabled: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly logger?: LogSink;
  readonly intervalMs?: number;
}

export class OnlineKeeper {
  private readonly addresses: () => readonly string[];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly logger: LogSink | null;
  private readonly intervalMs: number;
  private enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private address: string | null = null;
  private lastAt: Date | null = null;
  private reachable: boolean | null = null;
  private error: string | null = null;
  /** So a standing failure is said once rather than every few minutes. */
  private reported = false;

  public constructor(options: OnlineKeeperOptions) {
    this.addresses = options.addresses;
    this.enabled = options.enabled;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? null;
    this.intervalMs = options.intervalMs ?? INTERVAL_MS;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    // The manager is not kept alive by this timer. A process whose only
    // remaining work is holding itself awake has nothing left to be awake for.
    this.timer.unref();
  }

  public close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Turn it on or off, for a reader who has said which.
   *
   * Switching off forgets what the last attempt found. Leaving "unreachable"
   * standing on a switch that is now off would be reporting a failure of
   * something that is no longer being tried.
   */
  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.reachable = null;
    this.error = null;
    this.reported = false;
    if (!enabled) this.lastAt = null;
  }

  public state(): OnlineState {
    const address = this.enabled ? this.addresses()[0] ?? null : this.address;
    return {
      enabled: this.enabled,
      address: this.enabled ? address : null,
      status: this.status(address),
      lastAt: this.lastAt?.toISOString() ?? null,
      error: this.error,
    };
  }

  /**
   * One turn of the clock. Never throws: nothing waits on this.
   *
   * Public so a test can take a turn without one, and so the server can take
   * the first one as soon as the switch is turned on rather than leaving the
   * reader looking at a card that says nothing for four minutes.
   */
  public async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    const address = this.addresses()[0] ?? null;
    this.address = address;
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
      // rather than being left holding a socket open every four minutes.
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
      this.logger?.(logEvent('online.unreachable', `[manager] this manager could not reach its own address at ${this.address ?? 'nowhere'}: ${reason}`, { address: this.address ?? '', reason }));
      return;
    }
    if (reachable && was === false) {
      this.reported = false;
      this.logger?.(logEvent('online.reachable', `[manager] this manager can reach its own address again at ${this.address ?? 'nowhere'}`, { address: this.address ?? '' }));
    }
  }

  private status(address: string | null): OnlineState['status'] {
    if (!this.enabled) return 'off';
    if (!address) return 'no_address';
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
