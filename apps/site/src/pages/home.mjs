import { html, join, raw, text } from '../html.mjs';
import { iconOf, icons } from '../icons.mjs';
import { home } from '../content/home.mjs';
import { localeRoot } from '../content/strings.mjs';
import { localePath, prose } from '../links.mjs';
import { layout } from '../layout.mjs';
import { NARROW, aspect, screenshot } from '../shots.mjs';

/**
 * The landing page.
 *
 * It is read by somebody deciding whether to install this, who may never have
 * opened a terminal. So it leads with what the manager does for them, shows
 * each of those things as the screen they would actually see, and keeps the
 * machinery - ports, gateways, buckets - on the documentation page where the
 * people who want it will look.
 */
export function homePage(locale) {
  const c = home[locale];
  const root = localeRoot(locale);

  const body = html`
<section class="hero">
  <div class="shell">
    <img class="hero-mark" src="/assets/brand-mark.png" width="78" height="78" alt="">
    <p class="hero-badge">${icons.star()}${c.hero.badge}</p>
    <h1>${c.hero.heading}</h1>
    <p class="lede">${text(c.hero.lede)}</p>
    <div class="hero-actions">
      ${action(c.hero.primary)}
      ${action(c.hero.secondary, true)}
    </div>
    <p class="hero-meta">${join(c.hero.meta.map((item) => html`<span>${iconOf(item.icon)}${item.label}</span>`))}</p>
    <figure class="${NARROW} hero-shot">${screenshot(locale, c.hero.shot, c.hero.shotAlt, { narrow: true })}</figure>
  </div>
</section>

<section id="features">
  <div class="shell">
    ${sectionHead(c.features)}
    <div class="features">
      ${join(c.features.rows.map((row) => html`<article class="feature">
        <div class="feature-text">
          <p class="feature-label"><span class="feature-icon">${iconOf(row.icon)}</span>${row.label}${row.badge ? html`<span class="feature-badge">${row.badge}</span>` : ''}</p>
          <h3>${row.title}</h3>
          <p>${text(row.body)}</p>
          <ul class="feature-points">${join(row.points.map((point) => html`<li>${icons.check()}<span>${point}</span></li>`))}</ul>
        </div>
        <figure class="${NARROW} feature-shot${aspect(locale, row.shot) > 1 ? raw(' is-tall') : ''}">${screenshot(locale, row.shot, row.alt, { narrow: row.narrow })}</figure>
      </article>`))}
    </div>
  </div>
</section>

<section id="free">
  <div class="shell">
    ${sectionHead(c.trust)}
    <div class="grid grid-4">
      ${join(c.trust.cards.map((card) => html`<article class="card">
        <div class="card-icon">${iconOf(card.icon)}</div>
        <h3>${card.title}</h3>
        <p>${text(card.body)}</p>
      </article>`))}
    </div>
    <div class="note note-good after-grid">${icons.shield()}<p>${prose(c.trust.note, root)}</p></div>
  </div>
</section>

<section id="install">
  <div class="shell">
    ${sectionHead(c.install)}
    <div class="grid grid-3">
      ${join(c.install.cards.map((card) => html`<a class="card" href="${localePath(card.href, root)}">
        <div class="card-icon">${iconOf(card.icon)}</div>
        <h3>${card.title}</h3>
        <p>${text(card.body)}</p>
        <span class="card-go">${card.go}${icons.arrow()}</span>
      </a>`))}
    </div>
  </div>
</section>

<section id="more">
  <div class="shell">
    ${sectionHead(c.more)}
    <div class="grid grid-4">
      ${join(c.more.cards.map((card) => html`<article class="card card-quiet">
        <div class="card-icon">${iconOf(card.icon)}</div>
        <h3>${card.title}</h3>
        <p>${text(card.body)}</p>
      </article>`))}
    </div>
  </div>
</section>

<section id="screens">
  <div class="shell">
    ${sectionHead(c.screens)}
    <div class="screens">
      ${join(c.screens.shots.map((shot, index) => html`<input class="screen-pick" type="radio" name="screen" id="screen-${shot.name}"${index === 0 ? raw(' checked') : ''}>`))}
      <div class="screen-tabs">
        ${join(c.screens.shots.map((shot) => html`<label for="screen-${shot.name}">${shot.title}</label>`))}
      </div>
      <div class="screen-list">
        ${join(c.screens.shots.map((shot) => html`<figure class="screen">
          <div class="${NARROW}">${screenshot(locale, shot.name, shot.alt, { narrow: true })}</div>
          <figcaption><strong>${shot.title}</strong> ${text(shot.body)}</figcaption>
        </figure>`))}
      </div>
    </div>
  </div>
</section>

<section id="get" class="cta">
  <div class="shell">
    <h2>${c.cta.heading}</h2>
    <p class="lede">${c.cta.lede}</p>
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
    const href = external ? item.href : localePath(item.href, root);
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
