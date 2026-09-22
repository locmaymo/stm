/**
 * How often the console asks, and why that is one number rather than five.
 *
 * The console watches a handful of things that can change without it doing
 * anything: whether SillyTavern is up, whether a tunnel has an address yet,
 * whether the door in front of SillyTavern is open, how loaded the machine is,
 * what the log has said, what archives exist. It used to ask about all of them
 * every second and a half, forever, whatever was on screen and whether or not
 * anybody was looking - two hundred and thirty requests a minute on an idle
 * Overview page.
 *
 * That is expensive in three places at once. On the machine, because every one
 * of them is a session check and a JSON encode, which on a phone or a hosted
 * studio is real work. On the network, on a link somebody is paying for by the
 * megabyte. And on Cloudflare, because the console's own fixed address is a
 * Worker, and a Worker on the free plan answers a hundred thousand requests a
 * day - which that rate spends in seven hours, taking SillyTavern's address and
 * the backup Worker down with it, since all three share the one allowance.
 *
 * Two things fix that, and both are needed. The first is to stop asking on the
 * fast clock when nothing is moving: a second and a half is the right answer
 * while somebody has pressed Start and is watching for it to come up, and the
 * wrong answer for the other twenty-three hours. The second is to stop asking
 * more than once: the machine's meters, the log tail and the archive list all
 * ride along with the status answer now, so a screen costs one request rather
 * than four.
 *
 * Measured on an idle Overview: thirty-two requests a minute before, four
 * after. With the log opened full height, sixty-three before and twenty after.
 */

/** While something the reader is waiting on is in motion. */
export const POLL_LIVE_MS = 1_500;
/**
 * While everything is settled, and the answer is expected to be the same one.
 *
 * Fifteen seconds rather than eight, now that one answer carries what four
 * used to. It must stay under the manager's own CONSOLE_GAP_MS, which is
 * thirty seconds: that is the gap past which the manager stops counting this
 * poll as somebody being in front of the console, and a settled clock slower
 * than it would quietly stop the hours-used figure.
 */
export const POLL_SETTLED_MS = 15_000;
/**
 * While the log is open full height, which is somebody reading it as it runs.
 *
 * Three seconds rather than the one and a half the log used to follow on. The
 * log no longer has a clock of its own, so this is the clock for everything -
 * and at one and a half it was the single most expensive thing the console
 * did, at a moment when what is usually being read is a log that has already
 * stopped moving.
 */
export const POLL_LOG_MS = 3_000;
/**
 * For a question of its own that is still worth asking while a page is open:
 * how keeping the manager online is going, on the settings page.
 */
export const POLL_BACKGROUND_MS = 20_000;
/**
 * For a question whose answer changes on the order of days.
 *
 * Whether the manager itself has been superseded is one of those. Asking it
 * once as the page loads would leave a console that stays open for a week
 * showing what was true when it was opened; asking it on any of the clocks
 * above would be spending hundreds of requests a day on a fact that changes
 * when somebody cuts a release. The manager keeps its own answer for hours
 * either way, so this is a local request that usually goes nowhere.
 */
export const POLL_RELEASE_MS = 60 * 60_000;

interface WatchedProcess {
  readonly status: string;
}

interface WatchedTunnel {
  readonly status: string;
  /** A fixed address that is being deployed; see TunnelState.proxyPending. */
  readonly proxyPending?: boolean | undefined;
}

export interface WatchedState {
  readonly process?: WatchedProcess | null | undefined;
  readonly tunnel?: WatchedTunnel | null | undefined;
  readonly managerTunnel?: WatchedTunnel | null | undefined;
  /**
   * Work the console started and is reporting on: an install, a backup, a
   * restore, a transfer to or from the bucket.
   *
   * None of it is in the state below, and all of it is a reason to keep the
   * fast clock: the thing that finishes it is what the reader is waiting for.
   */
  readonly working?: boolean | undefined;
  /**
   * The log is open full height, which is the one thing on screen that moves
   * on its own without anything being "in motion" in the sense above.
   *
   * A log being read is a reason to ask often; it is not a reason to ask as
   * often as a start somebody is waiting on, so it has its own clock between
   * the two.
   */
  readonly readingLog?: boolean | undefined;
}

/** Whether anything the console watches is between one state and another. */
export function inMotion(state: WatchedState): boolean {
  if (state.working === true) return true;
  const process = state.process?.status;
  if (process === 'starting' || process === 'stopping') return true;
  for (const tunnel of [state.tunnel, state.managerTunnel]) {
    if (!tunnel) continue;
    if (tunnel.status === 'starting') return true;
    // The tunnel is up but the address somebody was given is not deployed yet.
    if (tunnel.proxyPending === true) return true;
  }
  return false;
}

export function statusIntervalMs(state: WatchedState): number {
  if (inMotion(state)) return POLL_LIVE_MS;
  return state.readingLog === true ? POLL_LOG_MS : POLL_SETTLED_MS;
}
