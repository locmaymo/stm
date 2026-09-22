/**
 * How often the console asks, and why that is not one number.
 *
 * The console watches a handful of things that can change without it doing
 * anything: whether SillyTavern is up, whether a tunnel has an address yet,
 * whether the door in front of SillyTavern is open. It used to ask about all of
 * them every second and a half, forever, whatever was on screen and whether or
 * not anybody was looking - two hundred and thirty requests a minute on an idle
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
 * A second and a half is the right answer while something is actually moving:
 * somebody pressed Start and is watching for it to come up. It is the wrong
 * answer for the other twenty-three hours, when the honest expectation is that
 * nothing will have changed. So the fast clock is kept for exactly the moments
 * it was added for, and the rest of the time the console asks rarely.
 */

/** While something the reader is waiting on is in motion. */
export const POLL_LIVE_MS = 1_500;
/** While everything is settled, and the answer is expected to be the same one. */
export const POLL_SETTLED_MS = 8_000;
/**
 * For something on screen that is worth keeping current, but is not what the
 * reader is looking at: the log card among the other cards on the Overview
 * page, rather than the log opened full height to be read.
 */
export const POLL_CARD_MS = 5_000;
/**
 * For the log tail when the log is not on screen.
 *
 * Not zero, because the header carries a dot that says something new has
 * arrived, and a dot that only lights on the page showing the log is a dot
 * that never tells anybody anything.
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
  return inMotion(state) ? POLL_LIVE_MS : POLL_SETTLED_MS;
}
