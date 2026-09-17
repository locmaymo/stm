import { html, join, raw } from '../html.mjs';
import { iconOf, icons } from '../icons.mjs';
import { docs } from '../content/docs.mjs';
import { snippets } from '../content/snippets.mjs';
import { localeRoot } from '../content/strings.mjs';
import { layout } from '../layout.mjs';
import { NARROW, screenshot } from '../shots.mjs';
import { prose } from '../links.mjs';

/**
 * The documentation page.
 *
 * One page rather than many: the whole of it is about twenty minutes to read,
 * every anchor is linkable, and a reader who has just failed to install
 * something can search the lot with one Ctrl+F rather than guessing which of
 * eight pages the sentence they half-remember was on.
 *
 * The contents list is generated from the sections themselves, so it cannot
 * point at a heading that is no longer there.
 */
export function docsPage(locale) {
  const c = docs[locale];
  const root = localeRoot(locale);

  const body = html`
<div class="docs">
  <div class="shell docs-shell">
    <header class="docs-head">
      <h1>${c.heading}</h1>
      <p class="lede">${c.lede}</p>
    </header>
    <nav class="docs-toc" aria-label="${c.tocLabel}">
      <p class="docs-toc-title">${c.tocLabel}</p>
      <ul>
        ${join(c.sections.map((section) => html`<li>
          <a href="#${section.id}">${section.title}</a>
          ${section.subsections ? html`<ul>${join(section.subsections.map((sub) => html`<li><a href="#${sub.id}">${sub.title}</a></li>`))}</ul>` : ''}
        </li>`))}
      </ul>
    </nav>
    <article class="docs-body">
      ${join(c.sections.map((section) => html`<section id="${section.id}" class="docs-section">
        <h2>${iconOf(section.icon)}${section.title}</h2>
        ${blocks(section.blocks, locale, root)}
        ${section.subsections ? join(section.subsections.map((sub) => html`<section id="${sub.id}" class="docs-sub">
          <h3><a class="anchor" href="#${sub.id}" aria-label="${sub.title}">#</a>${sub.title}</h3>
          ${blocks(sub.blocks, locale, root)}
        </section>`)) : ''}
      </section>`))}
    </article>
  </div>
</div>
`;

  return layout({
    locale,
    path: '/docs',
    title: c.title,
    description: c.description,
    body,
  });
}

function blocks(list, locale, root) {
  if (!list) return raw('');
  return join(list.map((block) => renderBlock(block, locale, root)));
}

function renderBlock(block, locale, root) {
  switch (block.type) {
    case 'p':
      return html`<p>${prose(block.body, root)}</p>`;
    case 'list':
      return html`<ul class="docs-list">${join(block.items.map((item) => html`<li>${prose(item, root)}</li>`))}</ul>`;
    case 'steps':
      return html`<ol class="docs-steps">${join(block.items.map((item) => html`<li>${prose(item, root)}</li>`))}</ol>`;
    case 'code':
      return codeBlock(block);
    case 'note':
      return html`<div class="note note-${block.tone}">${noteIcon(block.tone)}<p>${prose(block.body, root)}</p></div>`;
    case 'table':
      return html`<div class="table-wrap"><table>
        <thead><tr>${join(block.columns.map((column) => html`<th scope="col">${column}</th>`))}</tr></thead>
        <tbody>${join(block.rows.map((row) => html`<tr>${join(row.map((cell) => html`<td>${prose(cell, root)}</td>`))}</tr>`))}</tbody>
      </table></div>`;
    case 'shot':
      return html`<figure class="${NARROW} docs-shot">${screenshot(locale, block.name, block.alt, { narrow: 'mobile' })}</figure>`;
    default:
      return raw('');
  }
}

/**
 * A command, with the language it is written in and nothing to click.
 *
 * No copy button. It would need script on a page that otherwise needs none,
 * and every browser has selected a `<pre>` on double-click for thirty years.
 */
function codeBlock(block) {
  const snippet = snippets[block.snippet];
  if (!snippet) throw new Error(`Unknown snippet: ${block.snippet}`);
  return html`<figure class="code">
    <figcaption>${block.caption ?? snippet.lang}</figcaption>
    <pre><code>${snippet.code}</code></pre>
  </figure>`;
}

function noteIcon(tone) {
  if (tone === 'warn') return icons.warn();
  if (tone === 'good') return icons.check();
  return icons.info();
}

