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

  // A copy button on every command in the documentation. People following the
  // install steps on a phone or in a hurry copy the wrong half of a line; one
  // press takes all of it. Added here because without scripting the button
  // could not do anything.
  var COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  var DONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function copyText(value) {
    if (window.navigator.clipboard && window.isSecureContext) return window.navigator.clipboard.writeText(value);
    return new Promise(function (resolve, reject) {
      var field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      document.body.removeChild(field);
      if (copied) resolve(); else reject(new Error('copy refused'));
    });
  }

  function selectAll(element) {
    var range = document.createRange();
    range.selectNodeContents(element);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  var blocks = document.querySelectorAll('figure.code');
  for (var index = 0; index < blocks.length; index += 1) {
    (function (figure) {
      var code = figure.querySelector('pre');
      var caption = figure.querySelector('figcaption');
      if (!code || !caption) return;
      var label = figure.getAttribute('data-copy') || 'Copy';
      var done = figure.getAttribute('data-copied') || 'Copied';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.innerHTML = COPY_ICON + '<span></span>';
      button.lastChild.textContent = label;
      caption.appendChild(button);
      var timer = null;
      button.addEventListener('click', function () {
        copyText(code.innerText.replace(/\n+$/, '')).then(function () {
          button.setAttribute('data-state', 'done');
          button.innerHTML = DONE_ICON + '<span></span>';
          button.lastChild.textContent = done;
          window.clearTimeout(timer);
          timer = window.setTimeout(function () {
            button.removeAttribute('data-state');
            button.innerHTML = COPY_ICON + '<span></span>';
            button.lastChild.textContent = label;
          }, 1800);
        }, function () {
          // The clipboard was refused; leave the command selected so a
          // Ctrl+C, or the phone's own Copy, finishes the job.
          selectAll(code);
        });
      });
    })(blocks[index]);
  }

  // Things come up as they are scrolled to. Only what is still below the fold
  // is held back, so nothing on screen blinks out and back in, and a browser
  // without IntersectionObserver - or a reader who asked for less motion -
  // gets the page as it is.
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!still && 'IntersectionObserver' in window) {
    var watcher = new window.IntersectionObserver(function (entries) {
      for (var at = 0; at < entries.length; at += 1) {
        if (!entries[at].isIntersecting) continue;
        entries[at].target.classList.add('is-in');
        watcher.unobserve(entries[at].target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    var moving = document.querySelectorAll('main > section:not(.hero) .section-head, .feature-text, .feature-shot, main .grid > *, main > section .note, .screens, .cta .shell > *');
    for (var item = 0; item < moving.length; item += 1) {
      var element = moving[item];
      if (element.getBoundingClientRect().top < window.innerHeight) continue;
      element.classList.add('reveal');
      if (element.classList.contains('feature-shot')) {
        // The picture comes from the side it sits on: the right in odd rows,
        // the left in even ones, once the page is wide enough for two columns.
        var row = element.closest('.feature');
        var even = row && Array.prototype.indexOf.call(row.parentNode.children, row) % 2 === 1;
        if (window.innerWidth >= 900) element.classList.add(even ? 'from-left' : 'from-right');
        element.style.setProperty('--reveal-delay', '0.12s');
      } else if (element.parentNode.classList.contains('grid')) {
        var place = Array.prototype.indexOf.call(element.parentNode.children, element);
        element.style.setProperty('--reveal-delay', Math.min(place, 5) * 0.08 + 's');
      } else if (element.parentNode.classList.contains('shell') && element.closest('.cta')) {
        var step = Array.prototype.indexOf.call(element.parentNode.children, element);
        element.style.setProperty('--reveal-delay', step * 0.08 + 's');
      }
      watcher.observe(element);
    }
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
