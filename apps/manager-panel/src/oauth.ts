/**
 * Getting a Cloudflare sign-in back to the console that started it.
 *
 * Cloudflare's own sign-in refuses to load inside a frame - it answers with
 * `frame-ancestors 'none'`, and it is right to. So a console that is itself a
 * document inside another site's page cannot send itself there: it has to open
 * a window of its own and wait.
 *
 * Which leaves the return trip. Cloudflare sends the browser back to the
 * manager, so what lands is a second copy of the console, in the window that
 * was opened, signed in - and the console the reader is actually looking at,
 * in the frame, still showing the sign-in screen and knowing nothing about it.
 *
 * This is the way back. The opened window recognises itself as one, hands the
 * result to the window that opened it and closes; the console in the frame
 * hears it and carries on as though it had never left. The handover is
 * `postMessage` addressed to this exact origin - never `*`, because a session
 * token travels in it and `*` would hand it to whatever page happened to open
 * this one.
 */

/**
 * The name the window is opened under, so a second press reuses it rather than
 * opening another. Deliberately not what it is recognised by on the way back:
 * browsers clear a window's name when it navigates to another site, which is
 * exactly what this window does on its way to Cloudflare.
 */
export const RETURN_WINDOW = 'stm_cloudflare';

export const CLOUDFLARE_RESULT = 'stm:cloudflare-result';

/** What a sign-in ended as; `error` carries the reason in `code`. */
export type CloudflareOutcome = 'signed_in' | 'connected' | 'choose_account' | 'error';

const OUTCOMES: readonly string[] = ['signed_in', 'connected', 'choose_account', 'error'];

/** The session a sign-in opened, for the window that has to be given it. */
export interface HandedSession {
  readonly csrfToken: string;
  readonly token: string;
}

export interface CloudflareResult {
  readonly type: typeof CLOUDFLARE_RESULT;
  readonly outcome: CloudflareOutcome;
  /** The error code where the outcome is `error`, and empty otherwise. */
  readonly code: string;
  /** Set when the outcome is a sign-in, so the waiting console becomes it. */
  readonly session?: HandedSession;
}

/** What Cloudflare sent this window back with, if it sent it back at all. */
export function cloudflareOutcome(search: string): { outcome: CloudflareOutcome; code: string } | null {
  const params = new URLSearchParams(search);
  const outcome = params.get('cloudflare');
  if (!outcome || !OUTCOMES.includes(outcome)) return null;
  return { outcome: outcome as CloudflareOutcome, code: params.get('cloudflare_error') ?? '' };
}

/**
 * Whether this window might exist to carry a result back to another one.
 *
 * Having an opener is all that is asked, because it is all that survives the
 * trip: a window's name does not outlive a navigation to another site. So this
 * is a guess, and it is allowed to be wrong in one direction only. A window
 * that guesses yes and turns out to be nobody's - the console opened from some
 * other page's link, signed in the ordinary way - finds that its message goes
 * nowhere and it is not allowed to close, and becomes an ordinary console a
 * moment later; see the return view. A window with no opener at all is
 * certainly not one of these and is never delayed.
 */
export function isReturnWindow(win: Pick<Window, 'opener'>): boolean {
  return Boolean(win.opener) && win.opener !== win;
}

/** A result posted by such a window, or null for anything else on the wire. */
export function readCloudflareResult(data: unknown): CloudflareResult | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type !== CLOUDFLARE_RESULT) return null;
  if (typeof message.outcome !== 'string' || !OUTCOMES.includes(message.outcome)) return null;
  const session = message.session;
  const handed = typeof session === 'object' && session !== null
    && typeof (session as Record<string, unknown>).csrfToken === 'string'
    && typeof (session as Record<string, unknown>).token === 'string'
    ? session as unknown as HandedSession
    : undefined;
  return {
    type: CLOUDFLARE_RESULT,
    outcome: message.outcome as CloudflareOutcome,
    code: typeof message.code === 'string' ? message.code : '',
    ...(handed ? { session: handed } : {}),
  };
}

/**
 * Open the window a sign-in will happen in, now, while the click still counts.
 *
 * Opened blank and pointed at Cloudflare once the manager has answered with an
 * address: a window opened later, out of a promise, is a pop-up as far as the
 * browser is concerned and is blocked. Null means it was blocked anyway, and
 * the caller has to offer the address instead.
 */
export function openReturnWindow(): Window | null {
  const width = 600;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  return window.open('', RETURN_WINDOW, `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);
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
