import { useEffect } from 'react';
import { Button } from '../../../packages/ui/src/index.js';
import { PHONE_APP_RETURN, type CloudflareOutcome } from './oauth.js';
import { translator } from './i18n.js';
import type { LocaleCode } from './preferences.js';

/**
 * The window a Cloudflare sign-in came back to, getting out of the way.
 *
 * Rendered instead of the console, never beside it: the reader is looking at
 * the console in the frame that sent them here, and a second one opening in
 * this window - signed in, with its own idea of what is going on - is the
 * whole problem this exists to avoid.
 *
 * It carries nothing back. It cannot: the opener was severed by Cloudflare's
 * `Cross-Origin-Opener-Policy` on the way out, and what storage this window
 * has is in a different partition from the frame's. The answer goes home
 * through the manager instead, and by the time this renders it is already
 * there waiting to be collected; see oauth.ts. So this says a line and closes.
 *
 * A window that will not close is one that was not opened by a script, which
 * means it is somebody's console after all - reached by a link, with the
 * sign-in finished in it. It becomes that console rather than sitting here.
 */

/** Long enough for a window that is going to close to have done it. */
const CLOSE_GRACE_MS = 1200;

export function CloudflareReturn({ outcome, locale, app = false }: { outcome: CloudflareOutcome; locale: LocaleCode; app?: boolean }) {
  const t = translator(locale);
  useEffect(() => {
    /*
     * A sign-in the Android app started finished here, in the phone's
     * browser, and the app is where the reader belongs: it is already
     * collecting the answer. So this sends them back to it. A browser that
     * will not open an app without a fresh tap still shows the button below,
     * which is that tap.
     */
    if (app) {
      window.location.href = PHONE_APP_RETURN;
      return undefined;
    }
    window.close();
    const settled = window.setTimeout(
      () => window.location.replace(`${window.location.pathname}${window.location.hash}`),
      CLOSE_GRACE_MS,
    );
    return () => window.clearTimeout(settled);
  }, [app]);
  if (app) {
    return <div className="auth-shell grid content-center justify-items-center gap-4 p-6" role="status">
      <p className="text-sm text-muted-foreground text-center">
        {outcome === 'error' ? t('setup.cloudSignInFailed') : t('setup.cloudReturningApp')}
      </p>
      <Button asChild size="lg"><a href={PHONE_APP_RETURN}>{t('setup.cloudReturnToApp')}</a></Button>
    </div>;
  }
  return <div className="auth-shell" role="status">
    <p className="text-sm text-muted-foreground text-center">
      {outcome === 'error' ? t('setup.cloudSignInFailed') : t('setup.cloudReturning')}
      <br />
      {t('setup.cloudReturningClose')}
    </p>
  </div>;
}
