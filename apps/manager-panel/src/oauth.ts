/**
 * Getting a Cloudflare sign-in back to the console that started it.
 *
 * Cloudflare's own sign-in refuses to load inside a frame - it answers with
 * `frame-ancestors 'none'`, and it is right to. So a console that is itself a
 * document inside another site's page cannot send itself there: it has to open
 * a window of its own and wait.
 *
 * Which leaves the return trip, and the window comes back a stranger. Every
 * way a browser has of letting two windows recognise each other is gone by
 * then:
 *
 * - `window.opener` is null. Cloudflare's sign-in answers with
 *   `Cross-Origin-Opener-Policy: same-origin`, which puts the window into a
 *   browsing context group of its own and severs the opener for good; coming
 *   home afterwards does not bring it back.
 * - `window.name` is cleared on the way out to another site. Browsers restore
 *   it on the way back, but that is a courtesy, and not the same courtesy in
 *   each of them.
 * - `BroadcastChannel`, `localStorage` and the session cookie are partitioned
 *   by the site at the top of the page. A window is its own top; a frame's top
 *   is the site around it. They are in different partitions and share nothing.
 *
 * So the manager carries it instead. The console asks for a sign-in and is
 * given a name to collect the answer under; the window goes to Cloudflare and
 * comes back; the callback leaves the answer with the manager; the console
 * collects it and is signed in. None of that asks the browser to agree that
 * the two windows have anything to do with each other.
 *
 * The window's only remaining job is to not become a second console, and it
 * cannot work that out by itself either - so the manager tells it, in the one
 * place that survives the trip: the address it is sent home to.
 */

/** The name the window is opened under, so a second press reuses it. */
export const RETURN_WINDOW = 'stm_cloudflare';

/** What a sign-in ended as; `error` carries the reason in `code`. */
export type CloudflareOutcome = 'signed_in' | 'connected' | 'choose_account' | 'error';

const OUTCOMES: readonly string[] = ['signed_in', 'connected', 'choose_account', 'error'];

/** How often to ask whether the window has finished, and for how long. */
const ASK_EVERY_MS = 1200;
const ASK_FOR_MS = 10 * 60 * 1000;

export interface CloudflareReturn {
  readonly outcome: CloudflareOutcome;
  /** The error code where the outcome is `error`, and empty otherwise. */
  readonly code: string;
  /** Whether a console is waiting to collect this, so this page is a window. */
  readonly collected: boolean;
}

/** The session a sign-in opened, for the console collecting it. */
export interface CollectedSession {
  readonly csrfToken: string;
  readonly token: string;
}

export interface CollectedResult {
  readonly outcome: CloudflareOutcome;
  readonly code: string;
  readonly session: CollectedSession | null;
}

/** What Cloudflare sent this page back with, if it sent it back at all. */
export function cloudflareReturn(search: string): CloudflareReturn | null {
  const params = new URLSearchParams(search);
  const outcome = params.get('cloudflare');
  if (!outcome || !OUTCOMES.includes(outcome)) return null;
  return {
    outcome: outcome as CloudflareOutcome,
    code: params.get('cloudflare_error') ?? '',
    collected: params.get('handoff') === '1',
  };
}

/**
 * Whether this page is the window a sign-in happened in, rather than a console.
 *
 * The manager's own word for it comes first and is the only reliable half. An
 * opener is accepted as well, for a window this manager was never told about,
 * and a page with neither is certainly a console and is never held up.
 */
export function isReturnWindow(returned: CloudflareReturn | null, win: Pick<Window, 'opener'>): boolean {
  if (!returned) return false;
  return returned.collected || (Boolean(win.opener) && win.opener !== win);
}

/**
 * Ask the manager for the answer, until it has one.
 *
 * Polling rather than waiting to be told, because there is nobody to tell it:
 * see the note at the top. The manager answers `ready: false` while the reader
 * is still at Cloudflare, and a name it does not know - spent, expired, or
 * never issued - ends this rather than being asked about forever.
 *
 * Returns a function that stops it, for a console that is unmounted or that
 * heard the answer some other way.
 */
export function collectCloudflareResult(handoff: string, settle: (result: CollectedResult) => void, options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  wait?: (run: () => void, ms: number) => void;
} = {}): () => void {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((run, ms) => { setTimeout(run, ms); });
  const giveUpAt = now() + ASK_FOR_MS;
  let stopped = false;

  const ask = async (): Promise<void> => {
    if (stopped) return;
    try {
      const response = await fetchImpl('/api/v1/cloudflare/handoff', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handoff }),
      });
      // The name is spent or was never ours. Asking again cannot change that.
      if (response.status === 404) { stopped = true; return; }
      if (response.ok) {
        const payload = await response.json() as { ready?: boolean; outcome?: string; code?: string; session?: { csrfToken?: string }; token?: string };
        if (payload.ready === true && typeof payload.outcome === 'string' && OUTCOMES.includes(payload.outcome)) {
          stopped = true;
          const csrfToken = payload.session?.csrfToken;
          settle({
            outcome: payload.outcome as CloudflareOutcome,
            code: typeof payload.code === 'string' ? payload.code : '',
            session: typeof csrfToken === 'string' && typeof payload.token === 'string' ? { csrfToken, token: payload.token } : null,
          });
          return;
        }
      }
    } catch {
      // The manager is busy putting a machine back together, or the network
      // blinked. The answer is kept until it is collected, so asking again is
      // the whole of the fix.
    }
    if (!stopped && now() < giveUpAt) wait(() => void ask(), ASK_EVERY_MS);
  };
  void ask();
  return () => { stopped = true; };
}

/** How often to look at the window, and how long to keep collecting after it goes. */
const WATCH_EVERY_MS = 500;
const AFTER_CLOSED_MS = 3000;

/**
 * Notice a window the reader shut without finishing.
 *
 * Without this, a sign-in abandoned halfway leaves the console waiting on an
 * answer that is never coming - and waiting with its buttons disabled, so the
 * reader cannot start another one either. The console is stuck for as long as
 * the collecting runs, over a window they closed deliberately.
 *
 * The wait afterwards is because a window that finished also closes, and
 * closes the moment it gets home - before the console has had time to collect
 * what it left. So a closed window is only abandoned if nothing turns up in
 * the seconds after it.
 */
export function whenAbandoned(watched: Window, abandoned: () => void, options: {
  wait?: (run: () => void, ms: number) => void;
} = {}): () => void {
  const wait = options.wait ?? ((run, ms) => { setTimeout(run, ms); });
  let stopped = false;
  const look = () => {
    if (stopped) return;
    if (!watched.closed) { wait(look, WATCH_EVERY_MS); return; }
    wait(() => { if (!stopped) abandoned(); }, AFTER_CLOSED_MS);
  };
  wait(look, WATCH_EVERY_MS);
  return () => { stopped = true; };
}

/**
 * Open the window a sign-in will happen in, now, while the click still counts.
 *
 * Opened blank and pointed at Cloudflare once the manager has answered with an
 * address: a window opened later, out of a promise, is a pop-up as far as the
 * browser is concerned and is blocked. Null means it was blocked anyway, and
 * the caller has to offer the address instead.
 *
 * Whichever way it goes is written down, because the answer does not change
 * from one press to the next and a second failed attempt is a second pop-up
 * warning in the browser's own bar for nothing.
 */
export function openReturnWindow(storage?: PopupStorage): Window | null {
  const width = 600;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  const opened = window.open('', RETURN_WINDOW, `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);
  savePopupsBlocked(opened === null, storage ?? safeLocalStorage());
  return opened;
}

/** Where a browser that will not give this console a window is remembered. */
const POPUPS_BLOCKED_KEY = 'stm-popups-blocked';

export type PopupStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether this browser has already refused this console a window.
 *
 * Remembered so the refusal happens once. A console inside another site's page
 * is often in a frame that is simply not allowed to open windows at all - the
 * answer is the same every time, and trying again on every press costs the
 * reader a pop-up warning and costs this console the chance to offer the one
 * thing that does work: an ordinary link they press themselves.
 */
export function popupsBlocked(storage?: PopupStorage): boolean {
  try {
    return (storage ?? safeLocalStorage())?.getItem(POPUPS_BLOCKED_KEY) === 'yes';
  } catch {
    return false;
  }
}

export function savePopupsBlocked(blocked: boolean, storage?: PopupStorage): void {
  try {
    (storage ?? safeLocalStorage())?.setItem(POPUPS_BLOCKED_KEY, blocked ? 'yes' : 'no');
  } catch {
    // A private window, or site data the browser will not keep. Without it the
    // console tries a window again next time, which is where it started.
  }
}

/**
 * `localStorage`, where reaching for it is not itself a throw.
 *
 * In a frame with site data blocked, the property access raises rather than
 * returning null, and this runs on exactly that kind of page.
 */
function safeLocalStorage(): PopupStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether this console is a document inside some other site's page. */
export function framed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A frame on another site cannot always see what is around it, and being
    // refused the answer is itself the answer.
    return true;
  }
}
