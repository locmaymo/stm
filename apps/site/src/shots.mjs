import { html, raw } from './html.mjs';

/**
 * A screenshot that follows the theme, the language and the screen it is on.
 *
 * The repository already keeps every panel screenshot four ways - English and
 * Vietnamese, light and dark - for the README, and those are the images this
 * site shows. Both themes are in the markup and the stylesheet hides one,
 * rather than a `<picture>` on `prefers-color-scheme`: the theme here is a
 * class somebody chose in the corner of the page, and a `<picture>` would keep
 * answering the operating system instead.
 *
 * A `narrow` variant is the same page photographed on a phone. A desktop
 * screenshot shown at 390px is a grey rectangle with a suggestion of text in
 * it - technically the product, and no use to anyone deciding whether to
 * install it - so where a phone shot exists the small screen gets that one.
 *
 * Every copy is lazy. A hidden lazy image is generally never fetched at all,
 * which is what keeps four sources in the markup from costing four downloads.
 */
export function screenshot(locale, name, alt, { narrow } = {}) {
  const wide = [
    image(locale, name, 'light', alt, 'wide'),
    image(locale, name, 'dark', alt, 'wide'),
  ];
  if (!narrow) return html`${wide}`;
  return html`${wide}${[
    image(locale, narrow, 'light', alt, 'narrow'),
    image(locale, narrow, 'dark', alt, 'narrow'),
  ]}`;
}

/** The class a figure needs for its narrow variant to be used. */
export const NARROW = 'shot has-narrow';

function image(locale, name, theme, alt, width) {
  const size = width === 'narrow' ? 'width="720" height="1560"' : 'width="1600" height="1000"';
  return raw(`<img class="${width} ${theme}" src="/img/${locale}/${name}-${theme}.webp" alt="${escapeAttribute(alt)}" ${size} loading="lazy" decoding="async">`);
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
