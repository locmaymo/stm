import { useEffect } from 'react';
import { CLOUDFLARE_RESULT, type CloudflareOutcome, type HandedSession } from './oauth.js';
import { translator } from './i18n.js';
import type { LocaleCode } from './preferences.js';

/**
 * The window a Cloudflare sign-in came back to, handing the result on.
 *
 * Rendered instead of the console, never beside it: the reader is looking at
 * the console in the frame, and a second one opening here - signed in, with
 * its own idea of what is going on - is the whole problem this exists to fix.
 * So this window shows a line, gives what it came back with to the window that
 * opened it, and closes.
 *
 * A sign-in also carries the session. This window's own cookie works, because
 * a window of its own is not a frame and its cookie is nobody's third party;
 * the console waiting in the frame may have no cookie at all. Asking here and
 * handing over what comes back is what makes that console signed in.
 *
 * Addressed to this exact origin. The message holds a live session token, and
 * a `*` would post it to whatever page opened this window - which, for a
 * window anybody can open at this address, is not necessarily the console.
 *
 * Having an opener is only a guess that this is such a window, because nothing
 * stronger survives the trip through Cloudflare. So the guess is checked by
 * acting on it: a window that was opened by a script closes when it asks to,
 * and one that was not is still here a moment later - and becomes the console
 * it would have been, having lost nothing but the moment.
 */

/** Long enough for a window that may close to have done it. */
const CLOSE_GRACE_MS = 1200;
export function CloudflareReturn({ outcome, code, locale }: { outcome: CloudflareOutcome; code: string; locale: LocaleCode }) {
  const t = translator(locale);
  useEffect(() => {
    let done = false;
    const hand = (session?: HandedSession) => {
      if (done) return;
      done = true;
      try {
        (window.opener as Window | null)?.postMessage({ type: CLOUDFLARE_RESULT, outcome, code, ...(session ? { session } : {}) }, window.location.origin);
      } catch {
        // Nothing to be done from here; the line below is what is left.
      }
      window.close();
      // Still open means this was never one of those windows. Carry on as the
      // console, at the plain address so this does not run a second time.
      window.setTimeout(() => window.location.replace(`${window.location.pathname}${window.location.hash}`), CLOSE_GRACE_MS);
    };
    if (outcome !== 'signed_in') { hand(); return undefined; }
    const controller = new AbortController();
    void fetch('/api/v1/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => response.ok ? await response.json() as { session: { csrfToken: string }; token?: string } : null)
      .then((payload) => {
        hand(payload?.token ? { csrfToken: payload.session.csrfToken, token: payload.token } : undefined);
      })
      .catch(() => hand());
    return () => controller.abort();
  }, [outcome, code]);
  return <div className="auth-shell" role="status">
    <p className="text-sm text-muted-foreground text-center">
      {outcome === 'error' ? t('setup.cloudSignInFailed') : t('setup.cloudReturning')}
      <br />
      {t('setup.cloudReturningClose')}
    </p>
  </div>;
}
