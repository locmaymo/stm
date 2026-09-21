import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CloudflareReturn } from './cloudflare-return.js';
import { Gallery } from './gallery.js';
import { cloudflareReturn, isReturnWindow } from './oauth.js';
import { browserEnvironment, browserStorage, readPreferences } from './preferences.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Panel root is missing');
}

// The component workbench. Not a destination, not in the navigation, and not
// behind the session, because it renders nothing real - it exists so that a
// primitive can be looked at in both themes and at both widths before a page
// is built out of it.
const gallery = window.location.hash === '#gallery';

/*
 * A window opened to take a Cloudflare sign-in and bring it back.
 *
 * Decided here rather than inside the console, because the console is what it
 * must not become: Cloudflare returns to this manager, and left alone this
 * window would load a second signed-in console while the one the reader is
 * looking at - in a frame somewhere, which is why a window was needed at all -
 * carried on showing the sign-in screen. See oauth.ts.
 */
const returned = cloudflareReturn(window.location.search);
const returning = isReturnWindow(returned, window) ? returned : null;

// Neither of these is the console, and the console is what usually settles the
// theme and the language, so the two of them settle it here instead.
const chrome = gallery || returning ? readPreferences(browserStorage(), browserEnvironment()) : null;
if (chrome) {
  document.documentElement.classList.toggle('dark', chrome.theme === 'dark');
  document.documentElement.lang = chrome.locale;
}

createRoot(root).render(
  <StrictMode>
    {returning
      ? <CloudflareReturn outcome={returning.outcome} locale={chrome?.locale ?? 'en'} />
      : gallery ? <Gallery /> : <App />}
  </StrictMode>,
);

/*
 * Take the boot screen away once there is something behind it.
 *
 * Two frames, not one: the first is the frame this render is committed in, and
 * the second is the one it is painted in. Removing the screen any earlier
 * shows the empty page it was put there to cover.
 */
const boot = document.getElementById('boot');
if (boot) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    boot.dataset.done = 'true';
    window.setTimeout(() => boot.remove(), 220);
  }));
}
