import { readWorkersUsage, WORKERS_FREE_TIER, type WorkersUsageReport } from '../../../packages/cloudflare/src/index.js';
import { logEvent, type LogSink } from '../../../packages/contracts/src/index.js';
import type { CloudflareConnection } from '../../../packages/r2/src/index.js';
import type { ProxyWorkerTarget } from '../../../packages/cloudflare/src/index.js';

/**
 * How much of the day's Worker allowance is left, and what to stop doing.
 *
 * A manager with a Cloudflare account has three Workers on it: the fixed
 * address in front of SillyTavern, the fixed address in front of this console,
 * and the one that carries backup data to the bucket. On the free plan they
 * spend one allowance between them - a hundred thousand requests, resetting at
 * midnight UTC - and running it out does not degrade anything gracefully. Every
 * address on the account answers Cloudflare's 1027 error page until the day
 * turns over, backups included.
 *
 * So the manager watches the figure and gives things up in an order, cheapest
 * first. There is nothing to press and nothing on screen about it: what the
 * reader sees is that the address they are given goes back to being the
 * tunnel's own, and a line in the log saying why.
 *
 * What this cannot do is rescue an address somebody has already bookmarked. A
 * Worker past the limit is not invoked at all, so it cannot redirect; the
 * bookmark simply stops working until the day resets. Withholding an address
 * protects what is handed out from here on, and the real protection is the
 * console spending less in the first place.
 */
export type WorkerBudgetLevel = 'clear' | 'easing' | 'console' | 'shared';

/**
 * Where each step falls, as a share of the day's allowance.
 *
 * Ordered by who notices. Slowing this console's own polling is invisible and
 * costs nothing but a slower screen. Taking the fixed address off the console
 * affects one person, who has a local address and a tunnel address anyway.
 * Taking it off SillyTavern affects whoever was given the link, so it goes
 * last - and even at ninety per cent there are ten thousand requests left,
 * which is roughly thirty more SillyTavern page loads.
 */
export const WORKER_BUDGET_STEPS = { easing: 0.60, console: 0.75, shared: 0.90 } as const;

/**
 * How long a reading is trusted.
 *
 * Past this the level goes back to clear rather than holding the last
 * restriction: the figure is not known any more, and withholding somebody's
 * fixed address on the strength of an hour-old number that nothing has
 * confirmed is the wrong way to be wrong. A reading from a previous UTC day is
 * discarded outright, which is what makes the day's reset need no clock of its
 * own - the count simply starts again from nothing.
 */
const READING_STALE_MS = 60 * 60_000;
/** While there is room to spare. The figure moves slowly and lags anyway. */
const REFRESH_CLEAR_MS = 15 * 60_000;
/** Once a step has been passed, where the next one matters sooner. */
const REFRESH_TIGHT_MS = 5 * 60_000;

export interface WorkerBudgetState {
  readonly level: WorkerBudgetLevel;
  /** Requests counted for the account today, or null when it is not known. */
  readonly requests: number | null;
  readonly limit: number;
  readonly measuredAt: string | null;
  /** Which Worker is spending it, largest first. Empty when nothing is known. */
  readonly scripts: WorkersUsageReport['scripts'];
}

export interface WorkerBudgetOptions {
  /** Null where this manager has no Cloudflare sign-in configured at all. */
  readonly cloudflare: CloudflareConnection | null;
  readonly logger?: LogSink;
  readonly now?: () => Date;
  readonly read?: typeof readWorkersUsage;
}

function levelFor(share: number): WorkerBudgetLevel {
  if (share >= WORKER_BUDGET_STEPS.shared) return 'shared';
  if (share >= WORKER_BUDGET_STEPS.console) return 'console';
  if (share >= WORKER_BUDGET_STEPS.easing) return 'easing';
  return 'clear';
}

/** Whether a fixed address is given out at this level, for this Worker. */
export function withholdsAddress(level: WorkerBudgetLevel, target: ProxyWorkerTarget): boolean {
  if (target === 'manager') return level === 'console' || level === 'shared';
  return level === 'shared';
}

/** Whether the console should ask less often than it otherwise would. */
export function easesPolling(level: WorkerBudgetLevel): boolean {
  return level !== 'clear';
}

export class WorkerBudget {
  private readonly cloudflare: CloudflareConnection | null;
  private readonly logger: LogSink;
  private readonly now: () => Date;
  private readonly read: typeof readWorkersUsage;
  private reading: { report: WorkersUsageReport; at: number } | null = null;
  private reported: WorkerBudgetLevel = 'clear';
  /** One query at a time; the clock below can tick while one is in flight. */
  private busy = false;
  private nextAt = 0;

  public constructor(options: WorkerBudgetOptions) {
    this.cloudflare = options.cloudflare;
    this.logger = options.logger ?? ((): void => undefined);
    this.now = options.now ?? (() => new Date());
    this.read = options.read ?? readWorkersUsage;
  }

  /**
   * What to give up right now.
   *
   * Clear whenever the figure is not known, which covers a manager with no
   * Cloudflare account, one whose sign-in never granted analytics, and one
   * whose query is failing. None of those is a reason to take somebody's fixed
   * address away: an unknown figure is not a large one, and a manager that
   * quietly served tunnel addresses forever because a permission was missing
   * would have given up the feature it exists for.
   */
  public level(): WorkerBudgetLevel {
    const usable = this.usableReading();
    if (!usable) return 'clear';
    return levelFor(usable.requests / WORKERS_FREE_TIER.requestsPerDay);
  }

  public state(): WorkerBudgetState {
    const usable = this.usableReading();
    return {
      level: this.level(),
      requests: usable?.requests ?? null,
      limit: WORKERS_FREE_TIER.requestsPerDay,
      measuredAt: usable?.measuredAt ?? null,
      scripts: usable?.scripts ?? [],
    };
  }

  /**
   * Take the figure again if it is due, without making anybody wait for it.
   *
   * Called from the console's own poll, which is the request that says somebody
   * is in front of this - and the request whose pace this answer changes. A
   * manager nobody is looking at is a manager spending nothing on the console,
   * so there is nothing for it to decide.
   */
  public refresh(): void {
    if (this.busy) return;
    const at = this.now().getTime();
    if (at < this.nextAt) return;
    if (!this.cloudflare) return;
    this.busy = true;
    void (async () => {
      try {
        const status = await this.cloudflare!.status();
        // Nothing to read, and nothing being spent by this manager either.
        if (status.state !== 'connected' || !status.analyticsGranted || !status.account) {
          this.reading = null;
          this.nextAt = at + REFRESH_CLEAR_MS;
          return;
        }
        const before = this.level();
        const report = await this.read(this.cloudflare!.cloudflareApi(), status.account.id, this.now());
        this.reading = { report, at: this.now().getTime() };
        this.nextAt = this.now().getTime() + (this.level() === 'clear' ? REFRESH_CLEAR_MS : REFRESH_TIGHT_MS);
        this.announce(before, this.level(), report);
      } catch {
        /*
         * Left as it was, and asked again on the slow clock.
         *
         * Not treated as nothing used and not treated as a reason to restrict:
         * the reading simply ages out on its own, and the level goes back to
         * clear when it does.
         */
        this.nextAt = this.now().getTime() + REFRESH_CLEAR_MS;
      } finally {
        this.busy = false;
      }
    })();
  }

  /** A reading from today, recent enough to act on. */
  private usableReading(): WorkersUsageReport | null {
    const held = this.reading;
    if (!held) return null;
    if (this.now().getTime() - held.at > READING_STALE_MS) return null;
    // A reading taken before midnight UTC is about an allowance that has since
    // been given back. This is the whole of the reset: nothing is scheduled.
    const dayStart = new Date(Date.UTC(this.now().getUTCFullYear(), this.now().getUTCMonth(), this.now().getUTCDate())).toISOString();
    if (held.report.dayStart !== dayStart) return null;
    return held.report;
  }

  /**
   * Say it once, when it changes.
   *
   * Both ways: somebody whose shared link went back to a tunnel address needs
   * to be able to find out why, and somebody whose fixed address has come back
   * needs to know it is theirs to hand out again.
   */
  private announce(before: WorkerBudgetLevel, after: WorkerBudgetLevel, report: WorkersUsageReport): void {
    if (after === this.reported || after === before) { this.reported = after; return; }
    this.reported = after;
    const used = report.requests.toLocaleString('en-US');
    const limit = WORKERS_FREE_TIER.requestsPerDay.toLocaleString('en-US');
    const percent = Math.round((report.requests / WORKERS_FREE_TIER.requestsPerDay) * 100);
    if (after === 'clear') {
      this.logger(logEvent('cloudflare.budgetClear', `[cloudflare] ${used} of ${limit} Worker requests used today; the fixed addresses are being handed out again`, { used, limit, percent }));
      return;
    }
    if (after === 'easing') {
      this.logger(logEvent('cloudflare.budgetEasing', `[cloudflare] ${used} of today's ${limit} Worker requests are used (${percent}%); this console is asking less often to leave room for SillyTavern and for backups`, { used, limit, percent }));
      return;
    }
    if (after === 'console') {
      this.logger(logEvent('cloudflare.budgetConsole', `[cloudflare] ${used} of today's ${limit} Worker requests are used (${percent}%); this console's own fixed address is held back and the tunnel address is offered instead, so that SillyTavern's link and the backups keep working`, { used, limit, percent }));
      return;
    }
    this.logger(logEvent('cloudflare.budgetShared', `[cloudflare] ${used} of today's ${limit} Worker requests are used (${percent}%); SillyTavern's fixed address is held back and the tunnel address is offered instead. The allowance resets at midnight UTC. An address already shared goes on using the Worker and will stop answering if the day runs out`, { used, limit, percent }));
  }
}
