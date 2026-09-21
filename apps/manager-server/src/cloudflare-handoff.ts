import { randomBytes } from 'node:crypto';

/**
 * A Cloudflare sign-in that happened in a window, collected through here.
 *
 * Cloudflare's sign-in refuses to load in a frame, so a console inside another
 * site's page has to send the reader to a window of its own. Everything the
 * browser offers for getting the answer back out of that window fails on the
 * way:
 *
 * - `window.opener` is gone. Cloudflare's sign-in answers with
 *   `Cross-Origin-Opener-Policy: same-origin`, which puts the window in a
 *   browsing context group of its own and severs the opener for good - it is
 *   not restored by navigating home afterwards.
 * - `window.name` is cleared when a window navigates to another site. Browsers
 *   restore it on the way back, but that is a courtesy, not a guarantee, and
 *   it differs between them.
 * - Shared storage is not shared. `BroadcastChannel`, `localStorage` and the
 *   session cookie are all partitioned by the site at the top of the page, and
 *   a window is its own top while a frame's top is the site around it - so the
 *   two are in different partitions and cannot see each other's anything.
 *
 * What is left is the manager. The console asks for a sign-in and is given a
 * name to collect the answer under; the window goes away and comes back and
 * the callback leaves the answer here; the console collects it. Nothing in
 * that depends on the browser agreeing that the two windows are related,
 * because they need not be.
 *
 * The name is a secret, and it is the credential: whoever holds it collects
 * the session that sign-in opened. So it is random, it is issued only to the
 * page that started the sign-in, it is spent on the first collection, and it
 * expires with the sign-in it belongs to.
 */

/** As long as a sign-in has to finish in, which is what this outlives. */
const HANDOFF_TTL_MS = 10 * 60 * 1000;

/** Sign-ins can be started faster than they are finished; this is the ceiling. */
const HANDOFF_LIMIT = 8;

export interface HandoffResult {
  /** `signed_in`, `connected`, `choose_account` or `error`. */
  readonly outcome: string;
  /** The reason, where the outcome is `error`, and empty otherwise. */
  readonly code: string;
  /** The session a sign-in opened, for the console waiting to become it. */
  readonly sessionToken: string | null;
}

interface Handoff {
  readonly secret: string;
  readonly state: string;
  readonly createdAt: number;
  result: HandoffResult | null;
}

export type HandoffClaim =
  | { readonly status: 'waiting' }
  | { readonly status: 'ready'; readonly result: HandoffResult };

export class HandoffStore {
  private readonly waiting: Handoff[] = [];
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? HANDOFF_TTL_MS;
  }

  /** Name this sign-in, and hand the name to the console that asked for it. */
  public open(state: string): string {
    const secret = randomBytes(32).toString('base64url');
    this.prune().push({ secret, state, createdAt: this.now(), result: null });
    while (this.waiting.length > HANDOFF_LIMIT) this.waiting.shift();
    return secret;
  }

  /** Whether a sign-in is being collected this way, which decides the return page. */
  public isOpen(state: string): boolean {
    return this.prune().some((entry) => entry.state === state);
  }

  /** Leave the answer for whoever is waiting on it. */
  public settle(state: string, result: HandoffResult): void {
    const entry = this.prune().find((item) => item.state === state);
    if (entry) entry.result = result;
  }

  /**
   * Collect the answer, once.
   *
   * `null` is a name that is not waiting on anything: never issued, already
   * collected, or out of time. The console asking is told to stop asking,
   * rather than being left to poll a name that will never answer.
   */
  public claim(secret: string): HandoffClaim | null {
    const index = this.prune().findIndex((entry) => entry.secret === secret);
    if (index === -1) return null;
    const entry = this.waiting[index]!;
    if (!entry.result) return { status: 'waiting' };
    this.waiting.splice(index, 1);
    return { status: 'ready', result: entry.result };
  }

  private prune(): Handoff[] {
    const now = this.now();
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      if (now - this.waiting[index]!.createdAt > this.ttlMs) this.waiting.splice(index, 1);
    }
    return this.waiting;
  }
}
