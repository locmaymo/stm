import type { AvailableUpdate, VersionSwitch } from '../../../packages/contracts/src/index.js';

/**
 * Updating SillyTavern by itself, at night, for somebody who asked for it.
 *
 * Off unless switched on. When on, a new release is installed in the hour
 * after four in the morning, by this machine's clock, and only when nothing
 * has used SillyTavern for an hour - an update stops it, and nobody should
 * lose a reply they are waiting for to one. It is the same install a press of
 * Update starts, so it has the same safety copy, the same watch after the
 * start and the same way back (see version-probation.ts).
 *
 * One try a night. A release that was already taken back because it would not
 * run is not tried again: it would fail the same way every night.
 */

/** The hour, on this machine's clock, an update may start in. */
export const NIGHTLY_HOUR = 4;
/** How long nothing must have used SillyTavern before it is stopped for an update. */
export const IDLE_MS = 60 * 60 * 1000;
/** How often the clock is looked at. */
const TICK_MS = 5 * 60 * 1000;

export interface NightlyInput {
  readonly now: Date;
  readonly enabled: boolean;
  readonly update: AvailableUpdate | null;
  /** When anything last went through the door to SillyTavern, 0 for never. */
  readonly lastUseAt: number;
  /** The local day of the last try, as `localDay` writes it. */
  readonly lastTryDay: string | null;
  /** An install, a restore, a backup or an extension task is running. */
  readonly busy: boolean;
  readonly lastSwitch: VersionSwitch | null;
}

export type NightlyDecision = 'go' | 'disabled' | 'notTime' | 'noUpdate' | 'triedToday' | 'inUse' | 'busy' | 'failedBefore';

export function nightlyDecision(input: NightlyInput): NightlyDecision {
  if (!input.enabled) return 'disabled';
  if (input.now.getHours() !== NIGHTLY_HOUR) return 'notTime';
  if (!input.update) return 'noUpdate';
  if (input.lastTryDay === localDay(input.now)) return 'triedToday';
  const switched = input.lastSwitch;
  if (switched && switched.ref === input.update.ref && (switched.outcome === 'rolledBack' || switched.outcome === 'rollbackFailed')) return 'failedBefore';
  if (input.busy) return 'busy';
  if (input.lastUseAt > 0 && input.now.getTime() - input.lastUseAt < IDLE_MS) return 'inUse';
  return 'go';
}

/** The day on this machine's clock, which is the one "four in the morning" is read on. */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface NightlyUpdaterOptions {
  readonly enabled: () => Promise<boolean>;
  readonly update: () => Promise<AvailableUpdate | null>;
  readonly lastUseAt: () => number;
  readonly busy: () => boolean;
  readonly lastSwitch: () => Promise<VersionSwitch | null>;
  /** Start the install; resolves once it is queued. */
  readonly install: (update: AvailableUpdate) => Promise<void>;
  readonly now?: () => Date;
}

export class NightlyUpdater {
  private clock: NodeJS.Timeout | null = null;
  private lastTryDay: string | null = null;

  public constructor(private readonly options: NightlyUpdaterOptions) {}

  public start(intervalMs = TICK_MS): void {
    if (this.clock) return;
    this.clock = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs);
    this.clock.unref();
  }

  public close(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  /** One look at the clock. Public so a test can take it without waiting. */
  public async tick(): Promise<NightlyDecision> {
    const now = (this.options.now ?? (() => new Date()))();
    const enabled = await this.options.enabled();
    // Nothing else is asked of a manager that has it off, or outside the hour.
    if (!enabled || now.getHours() !== NIGHTLY_HOUR) return enabled ? 'notTime' : 'disabled';
    const update = await this.options.update().catch(() => null);
    const decision = nightlyDecision({
      now,
      enabled,
      update,
      lastUseAt: this.options.lastUseAt(),
      lastTryDay: this.lastTryDay,
      busy: this.options.busy(),
      lastSwitch: await this.options.lastSwitch(),
    });
    if (decision !== 'go' || !update) return decision;
    this.lastTryDay = localDay(now);
    await this.options.install(update);
    return decision;
  }
}
