/*
 * Pick the theme before the page is painted.
 *
 * Loaded synchronously in the head, so it runs before the first paint and
 * nobody chooses dark and gets a white flash on the way in. It is a file
 * rather than an inline script because the site's Content-Security-Policy is
 * `script-src 'self'`, and a policy with no inline exception is one fewer
 * thing to get wrong later.
 *
 * `stm-theme` is the same key the panel uses, so a reader who set dark in one
 * gets dark in the other on the same machine. The two are different origins in
 * practice, so this is a convention rather than a shared value.
 */
(function () {
  try {
    var stored = window.localStorage.getItem('stm-theme');
    var dark = stored === 'dark' || (stored !== 'light' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch {
    // No storage, or storage that throws in a private window. The stylesheet's
    // own light default then applies, which is readable either way.
  }
})();
