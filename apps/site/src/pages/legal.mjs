import en from '../../../../packages/legal/locales/en.json' with { type: 'json' };
import vi from '../../../../packages/legal/locales/vi.json' with { type: 'json' };
import { html, join, text } from '../html.mjs';
import { icons } from '../icons.mjs';
import { localeRoot, strings } from '../content/strings.mjs';
import { layout } from '../layout.mjs';

/**
 * The terms, disclaimer, privacy notice and notices, as pages.
 *
 * The text is not written here. It is read straight out of `packages/legal`,
 * the same file the manager compiles into its own dialog, so the page somebody
 * is sent to and the text somebody accepted at their first run cannot say
 * different things. The parity gate holds the two languages to the same
 * sections and the same paragraph counts; this only lays them out.
 *
 * Sections are numbered in the markup rather than by a CSS counter, so a
 * clause can be cited by its number in an e-mail and still be findable by
 * somebody reading the page a year later.
 */

const bundles = { en, vi };

/** The documents, in the order they are offered, matching the manager's tabs. */
export const LEGAL_DOCUMENTS = ['terms', 'disclaimer', 'privacy', 'notices'];

export function legalPage(locale, id) {
  const bundle = bundles[locale];
  const document = bundle.documents[id];
  if (!document) throw new Error(`No ${id} document in the ${locale} legal bundle`);
  const root = localeRoot(locale);
  const s = strings[locale];
  const sections = Object.entries(document.sections);

  const body = html`
<div class="docs legal-page">
  <div class="shell docs-shell">
    <header class="docs-head">
      <p class="eyebrow">${icons.scale()}${s.legal.label}</p>
      <h1>${document.title}</h1>
      <p class="lede">${document.summary}</p>
      <p class="legal-meta">
        ${interpolate(bundle.labels.effectiveFrom, { date: formatDate(bundle.meta.effective, locale) })}
        · ${interpolate(bundle.labels.revisionLabel, { revision: bundle.meta.revision })}
        · ${interpolate(bundle.labels.readingTime, { minutes: readingMinutes(document) })}
      </p>
    </header>
    <nav class="docs-toc" aria-label="${s.legal.documents}">
      <p class="docs-toc-title">${s.legal.documents}</p>
      <ul>
        ${join(LEGAL_DOCUMENTS.map((other) => html`<li><a href="${root}/${other}"${other === id ? html` aria-current="page"` : ''}>${bundle.documents[other].short}</a></li>`))}
      </ul>
      <p class="docs-toc-title docs-toc-next">${s.legal.inThisDocument}</p>
      <ul>
        ${join(sections.map(([sectionId, section], index) => html`<li><a href="#${sectionId}"><span class="legal-number">${index + 1}.</span>${section.heading}</a></li>`))}
      </ul>
    </nav>
    <article class="docs-body">
      ${join(sections.map(([sectionId, section], index) => html`<section id="${sectionId}" class="legal-section">
        <h2><span class="legal-number" aria-hidden="true">${index + 1}.</span>${section.heading}</h2>
        ${join(section.body.map((paragraph) => html`<p>${text(paragraph)}</p>`))}
      </section>`))}
      <footer class="legal-foot">
        <p>${text(s.legal.footer)}</p>
        <p>${join(LEGAL_DOCUMENTS.filter((other) => other !== id).map((other) => html`<a href="${root}/${other}">${bundle.documents[other].title}</a>`), ' · ')}</p>
      </footer>
    </article>
  </div>
</div>
`;

  return layout({
    locale,
    path: `/${id}`,
    title: document.title,
    description: document.summary,
    body,
  });
}

/** The same `{name}` substitution the manager's own catalogues use. */
function interpolate(template, values) {
  return template.replace(/\{([^{}]+)\}/gu, (match, key) => (key in values ? String(values[key]) : match));
}

/** Whole minutes at 200 words a minute, never below one - as the panel counts it. */
function readingMinutes(document) {
  const words = Object.values(document.sections)
    .flatMap((section) => [section.heading, ...section.body])
    .reduce((total, value) => total + value.split(/\s+/u).filter(Boolean).length, 0);
  return Math.max(1, Math.round(words / 200));
}

function formatDate(iso, locale) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(date);
  } catch {
    return iso;
  }
}
