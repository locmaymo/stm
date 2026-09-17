/*
 * The two switches in the corner, and nothing else.
 *
 * The site is static pages; this only remembers a preference and flips a
 * class. Language is a different URL rather than a class, because a page in
 * Vietnamese should be linkable, shareable and indexable as such - the
 * counterpart address is written into the button by the build.
 */
(function () {
  var root = document.documentElement;

  var toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var dark = !root.classList.contains('dark');
      root.classList.toggle('dark', dark);
      try {
        window.localStorage.setItem('stm-theme', dark ? 'dark' : 'light');
      } catch {
        // The class is already flipped; only the memory of it is lost.
      }
      toggle.setAttribute('aria-label', toggle.getAttribute(dark ? 'data-label-light' : 'data-label-dark') || '');
    });
  }

  // Remember which language was chosen, so the next visit to the bare domain
  // opens in it. Only ever set by a click on the switch: an address somebody
  // typed or was sent is answered as typed, never redirected.
  var language = document.querySelector('[data-lang-switch]');
  if (language) {
    language.addEventListener('click', function () {
      try {
        window.localStorage.setItem('stm-locale', language.getAttribute('data-locale') || 'en');
      } catch {
        // Nothing to do; the link still navigates.
      }
    });
  }
})();
