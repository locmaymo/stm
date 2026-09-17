import { html, join, raw } from './html.mjs';
import { icons } from './icons.mjs';
import { LOCALES, REPOSITORY, SITE_ORIGIN, localeRoot, strings } from './content/strings.mjs';

/**
 * The shell every page is served in.
 *
 * One head, one bar, one footer, written once so the pages underneath are only
 * their own content. The two switches in the corner are the whole of the
 * interactivity: a theme class, and a link to the same page in the other
 * language. Everything else works with scripting turned off.
 *
 * Both languages are declared to search engines with `hreflang`, including
 * `x-default` on the English page, so the right one is offered to a reader who
 * arrives from a search rather than from the switch.
 */

/**
 * @param {object} page
 * @param {'en'|'vi'} page.locale
 * @param {string} page.path       the path this page is served at, e.g. `/docs`
 * @param {string} page.title      the `<title>`, without the site name
 * @param {string} page.description
 * @param {import('./html.mjs').Raw} page.body
 * @param {string} [page.bodyClass]
 */
export function layout(page) {
  const s = strings[page.locale];
  const root = localeRoot(page.locale);
  const canonical = `${SITE_ORIGIN}${root}${page.path === '/' ? '/' : page.path}`;
  const alternates = LOCALES.map((locale) => {
    const href = `${SITE_ORIGIN}${localeRoot(locale)}${page.path === '/' ? '/' : page.path}`;
    return html`<link rel="alternate" hreflang="${locale}" href="${href}">`;
  });
  const other = page.locale === 'en' ? 'vi' : 'en';
  const otherHref = `${localeRoot(other)}${page.path === '/' ? '/' : page.path}`;

  return `<!doctype html>
<html lang="${page.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${html`${page.title}`} · SillyTavern Manager</title>
<meta name="description" content="${html`${page.description}`}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f9fc">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f141b">
<link rel="canonical" href="${canonical}">
${join(alternates)}
<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${page.path === '/' ? '/' : page.path}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SillyTavern Manager">
<meta property="og:locale" content="${page.locale === 'vi' ? 'vi_VN' : 'en_GB'}">
<meta property="og:title" content="${html`${page.title}`}">
<meta property="og:description" content="${html`${page.description}`}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE_ORIGIN}/assets/brand-mark.png">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/assets/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" sizes="512x512" href="/assets/icon-512.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="preload" as="font" type="font/woff2" href="/assets/noto-sans-latin.woff2" crossorigin>
<script src="/assets/boot.js"></script>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body${page.bodyClass ? ` class="${page.bodyClass}"` : ''}>
<a class="skip-link" href="#main">${html`${s.skip}`}</a>
<header class="site-head">
  <div class="shell">
    <a class="brand" href="${root || '/'}">
      <img src="/assets/brand-mark.png" width="26" height="26" alt="">
      <span class="brand-full">SillyTavern Manager</span>
      <span class="brand-short" aria-hidden="true">ST Manager</span>
    </a>
    <nav class="head-nav" aria-label="${html`${s.language}`}">
      ${join(s.nav.map((item) => html`<a href="${item.href}"${page.path === item.href.replace(root, '') ? raw(' aria-current="page"') : raw('')}>${item.label}</a>`))}
    </nav>
    <div class="head-tools">
      <a class="lang-button" data-lang-switch data-locale="${other}" href="${otherHref}" title="${html`${s.switchLanguage}`}" hreflang="${other}">
        ${icons.languages()}<span>${html`${s.otherLanguage}`}</span>
      </a>
      <button class="icon-button" type="button" data-theme-toggle aria-label="${html`${s.useDark}`}" data-label-dark="${html`${s.useDark}`}" data-label-light="${html`${s.useLight}`}">
        <span data-theme-icon="light">${icons.moon()}</span>
        <span data-theme-icon="dark">${icons.sun()}</span>
      </button>
      <a class="icon-button" href="${REPOSITORY}" target="_blank" rel="noreferrer noopener" aria-label="GitHub">${icons.github()}</a>
    </div>
  </div>
</header>
<main id="main">
${page.body}
</main>
<footer class="site-foot">
  <div class="shell">
    <div class="foot-grid">
      <div class="foot-about">
        <a class="brand" href="${root || '/'}">
          <img src="/assets/brand-mark.png" width="26" height="26" alt="">
          <span>SillyTavern Manager</span>
        </a>
        <p>${html`${s.footer.about}`}</p>
        <p>${html`${s.footer.independence}`}</p>
      </div>
      ${join(s.footer.columns.map((column) => html`<div>
        <h2>${column.title}</h2>
        <ul>${join(column.links.map((link) => html`<li><a href="${link.href}"${link.href.startsWith('http') ? raw(' target="_blank" rel="noreferrer noopener"') : raw('')}>${link.label}</a></li>`))}</ul>
      </div>`))}
    </div>
    <div class="foot-bottom">
      <span>${html`${s.footer.licence}`}</span>
      <a class="spacer" href="${otherHref}" hreflang="${other}" data-lang-switch data-locale="${other}">${html`${s.otherLanguage}`}</a>
    </div>
  </div>
</footer>
<script src="/assets/site.js" defer></script>
</body>
</html>
`;
}
