import { html, join, paragraphs, raw, text } from '../html.mjs';
import { iconOf, icons } from '../icons.mjs';
import { home } from '../content/home.mjs';
import { localeRoot } from '../content/strings.mjs';
import { layout } from '../layout.mjs';
import { NARROW, screenshot } from '../shots.mjs';

export function homePage(locale) {
  const c = home[locale];
  const root = localeRoot(locale);

  const body = html`
<section class="hero">
  <div class="shell">
    <img class="hero-mark" src="/assets/brand-mark.png" width="78" height="78" alt="">
    <h1>${c.hero.heading}</h1>
    <p class="lede">${text(c.hero.lede)}</p>
    <div class="hero-actions">
      ${action(c.hero.primary)}
      ${action(c.hero.secondary, true)}
    </div>
    <p class="hero-meta">${join(c.hero.meta.map((item) => html`<span>${iconOf(item.icon)}${item.label}</span>`))}</p>
    <figure class="${NARROW}">${screenshot(locale, c.hero.shot, c.hero.shotAlt, { narrow: 'mobile' })}</figure>
  </div>
</section>

<section id="what">
  <div class="shell">
    ${sectionHead(c.what)}
    <div class="grid grid-3">
      ${join(c.what.cards.map((card) => html`<article class="card">
        <div class="card-icon">${iconOf(card.icon)}</div>
        <h3>${card.title}</h3>
        <p>${text(card.body)}</p>
      </article>`))}
    </div>
  </div>
</section>

<section id="install">
  <div class="shell">
    ${sectionHead(c.install)}
    <div class="grid grid-3">
      ${join(c.install.cards.map((card) => html`<a class="card" href="${card.href}">
        <div class="card-icon">${iconOf(card.icon)}</div>
        <h3>${card.title}</h3>
        <p>${text(card.body)}</p>
        <span class="card-go">${card.go}${icons.arrow()}</span>
      </a>`))}
    </div>
  </div>
</section>

<section id="how">
  <div class="shell">
    ${sectionHead(c.how)}
    <div class="grid grid-2">
      <figure class="figure">
        ${portDiagram(locale)}
        <figcaption>${c.how.caption}</figcaption>
      </figure>
      <div class="grid" style="align-content:start">
        <div class="table-wrap">
          <table>
            <thead><tr>${join(c.how.table.columns.map((column) => html`<th scope="col">${column}</th>`))}</tr></thead>
            <tbody>${join(c.how.table.rows.map(([port, listens, reach]) => html`<tr><td><code>${port}</code></td><td>${listens}</td><td>${reach}</td></tr>`))}</tbody>
          </table>
        </div>
        <div class="note note-good">${icons.shield()}<p>${text(c.how.note)}</p></div>
      </div>
    </div>
  </div>
</section>

<section id="screens">
  <div class="shell">
    ${sectionHead(c.screens)}
    <div class="grid">
      ${join(c.screens.shots.map((shot) => html`<figure class="shot">${screenshot(locale, shot.name, shot.alt)}</figure>`))}
    </div>
  </div>
</section>

<section id="backups">
  <div class="shell">
    ${sectionHead(c.backups)}
    <div class="grid grid-3">
      ${join(c.backups.points.map((point) => html`<article class="card">
        <div class="card-icon">${iconOf(point.icon)}</div>
        <h3>${point.title}</h3>
        <p>${text(point.body)}</p>
      </article>`))}
    </div>
    <div class="note note-warn" style="margin-top:14px">${icons.warn()}<p>${text(c.backups.note)}</p></div>
  </div>
</section>

<section id="privacy">
  <div class="shell prose-shell">
    ${sectionHead(c.privacy)}
    ${paragraphs(c.privacy.body)}
  </div>
</section>

<section id="get" style="text-align:center">
  <div class="shell">
    <h2>${c.cta.heading}</h2>
    <p class="lede" style="max-width:36rem;margin-inline:auto">${c.cta.lede}</p>
    <div class="hero-actions">
      ${action(c.cta.primary)}
      ${action(c.cta.secondary, true)}
    </div>
  </div>
</section>
`;

  return layout({
    locale,
    path: '/',
    title: c.title,
    description: c.description,
    body,
  });

  function action(item, quiet = false) {
    const external = item.href.startsWith('http');
    const href = external || item.href.startsWith(root) ? item.href : `${root}${item.href}`;
    return html`<a class="button${quiet ? raw(' button-quiet') : raw('')}" href="${href}"${external ? raw(' target="_blank" rel="noreferrer noopener"') : raw('')}>${iconOf(item.icon)}${item.label}</a>`;
  }
}

function sectionHead(section) {
  return html`<div class="section-head">
    ${section.eyebrow ? html`<p class="eyebrow">${section.eyebrow}</p>` : ''}
    <h2>${section.heading}</h2>
    ${section.lede ? html`<p>${text(section.lede)}</p>` : ''}
  </div>`;
}

/**
 * The three ports, drawn rather than described.
 *
 * The README says this in Mermaid, which needs a renderer; here it is plain
 * SVG using the theme's own custom properties, so it follows light and dark
 * without a second copy and scales to any column width. The only thing the
 * picture has to carry is that two arrows pass a passcode and one does not,
 * and that nothing outside the box reaches SillyTavern directly.
 */
function portDiagram(locale) {
  const labels = locale === 'vi'
    ? { machine: 'Máy của bạn', panel: 'Bảng quản trị', gateway: 'Cổng truy cập', silly: 'SillyTavern', you: 'Bạn, trên máy này', lan: 'Điện thoại cùng Wi-Fi', tunnel: 'Cloudflare Tunnel', pass: 'mã truy cập', only: 'chỉ nội bộ' }
    : { machine: 'Your machine', panel: 'Manager panel', gateway: 'Access gateway', silly: 'SillyTavern', you: 'You, on this machine', lan: 'Phone on the same Wi-Fi', tunnel: 'Cloudflare Tunnel', pass: 'passcode', only: 'localhost only' };

  return raw(`<svg viewBox="0 0 420 300" role="img" aria-label="${labels.machine}: 7860, 8001, 8000">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10Z" fill="var(--muted-foreground)"/>
    </marker>
  </defs>
  <g font-family="inherit" font-size="10">
    <rect x="168" y="8" width="244" height="284" rx="14" fill="color-mix(in srgb, var(--primary) 6%, transparent)" stroke="var(--border)" stroke-dasharray="5 4"/>
    <text x="290" y="28" text-anchor="middle" fill="var(--muted-foreground)" font-size="10.5" font-weight="650">${labels.machine}</text>

    <rect x="190" y="42" width="200" height="50" rx="10" fill="var(--card)" stroke="var(--border)"/>
    <text x="206" y="66" fill="var(--foreground)" font-size="11.5" font-weight="620">${labels.panel}</text>
    <text x="206" y="81" fill="var(--muted-foreground)" font-family="monospace">:7860</text>

    <rect x="190" y="122" width="200" height="50" rx="10" fill="var(--card)" stroke="var(--border)"/>
    <text x="206" y="146" fill="var(--foreground)" font-size="11.5" font-weight="620">${labels.gateway}</text>
    <text x="206" y="161" fill="var(--muted-foreground)" font-family="monospace">:8001</text>

    <rect x="190" y="212" width="200" height="54" rx="10" fill="var(--muted)" stroke="var(--border)"/>
    <text x="206" y="236" fill="var(--foreground)" font-size="11.5" font-weight="620">${labels.silly}</text>
    <text x="206" y="251" fill="var(--muted-foreground)" font-family="monospace">:8000 · ${labels.only}</text>

    <!-- The panel reaches SillyTavern directly, so its line goes around the
         gateway rather than through it; drawn through the box it read as the
         panel talking to the gateway, which is the one thing it never does. -->
    <path d="M214 92 214 104 182 104 182 238 190 238" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
    <path d="M348 172 348 212" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>

    <text x="8" y="60" fill="var(--muted-foreground)">${labels.you}</text>
    <path d="M150 66 190 66" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>

    <text x="8" y="132" fill="var(--muted-foreground)">${labels.lan}</text>
    <text x="8" y="196" fill="var(--muted-foreground)">${labels.tunnel}</text>
    <path d="M150 138 170 138 170 147 190 147" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
    <path d="M150 192 170 192 170 154 190 154" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
    <text x="118" y="168" text-anchor="middle" fill="var(--attention)" font-size="9.5" font-weight="650">${labels.pass}</text>
  </g>
</svg>`);
}
