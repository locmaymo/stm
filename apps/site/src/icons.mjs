import { raw } from './html.mjs';

/*
 * The icons the site uses, inline.
 *
 * Drawn from the same families the panel uses - Lucide for interface marks,
 * the vendors' own shapes for the services - and inlined rather than loaded,
 * because a sprite sheet or an icon font would be a second request for a few
 * hundred bytes of path data on a page that is otherwise one HTML file, one
 * stylesheet and two small scripts.
 *
 * `currentColor` throughout, so an icon follows the text it sits beside and
 * the dark theme needs no second copy. GitHub is filled rather than stroked,
 * which is how that mark is drawn.
 */

const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function icon(body, extra = '') {
  return raw(`<svg viewBox="0 0 24 24" aria-hidden="true" ${extra || stroke}>${body}</svg>`);
}

export const icons = {
  download: () => icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  book: () => icon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>'),
  arrow: () => icon('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
  check: () => icon('<path d="M20 6 9 17l-5-5"/>'),
  shield: () => icon('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="m9 12 2 2 4-4"/>'),
  archive: () => icon('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
  cloud: () => icon('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'),
  chart: () => icon('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16v-5"/><path d="M12 16V8"/><path d="M17 16v-3"/>'),
  globe: () => icon('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  layers: () => icon('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 10.37-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/>'),
  languages: () => icon('<path d="m5 8 6 6"/><path d="m4 14 6-6 3-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>'),
  terminal: () => icon('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
  monitor: () => icon('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
  phone: () => icon('<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>'),
  apple: () => icon('<path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"/><path d="M10 2c1 .5 2 2 2 5"/>'),
  server: () => icon('<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>'),
  box: () => icon('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
  info: () => icon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  warn: () => icon('<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  sun: () => icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'),
  moon: () => icon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  scale: () => icon('<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>'),
  lock: () => icon('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  github: () => icon('<path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5A11.5 11.5 0 0 0 12 .5Z"/>', 'fill="currentColor"'),
  npm: () => raw('<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M1.8 8.2h20.4v7.6H12v1.4H6.9v-1.4H1.8Zm1.7 6.1h1.7v-4.6h1.7v4.6h1.7V8.2H3.5Zm6.8-6.1v7.6h3.4v-1.5h3.4V8.2Zm3.4 1.5h1.7v3.1h-1.7Zm5.1-1.5v6.1h3.4V9.7h1.7v4.6h1.7V8.2Z"/></svg>'),
};

/** A Lucide-shaped icon by name, or nothing when the name is unknown. */
export function iconOf(name) {
  const draw = icons[name];
  return draw ? draw() : raw('');
}
