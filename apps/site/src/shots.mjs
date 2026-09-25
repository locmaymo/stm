import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * A `narrow` variant is the same page photographed on a phone, kept beside the
 * desktop one as `<name>-mobile`. A desktop screenshot shown at 390px is a grey
 * rectangle with a suggestion of text in it - technically the product, and no
 * use to anyone deciding whether to install it - so the small screen gets the
 * phone shot of the same page. Each page has its own: a phone reading about
 * backups is shown the data page, not the overview again.
 *
 * Every copy is lazy. A hidden lazy image is generally never fetched at all,
 * which is what keeps four sources in the markup from costing four downloads.
 */
export function screenshot(locale, name, alt, { narrow = false } = {}) {
  const wide = [
    image(locale, name, 'light', alt, 'wide'),
    image(locale, name, 'dark', alt, 'wide'),
  ];
  if (!narrow) return html`${wide}`;
  const phone = typeof narrow === 'string' ? narrow : `${name}-mobile`;
  return html`${wide}${[
    image(locale, phone, 'light', alt, 'narrow'),
    image(locale, phone, 'dark', alt, 'narrow'),
  ]}`;
}

/** The class a figure needs for its narrow variant to be used. */
export const NARROW = 'shot has-narrow';

const screenshots = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.github', 'screenshots');

/*
 * The size each file actually is, read from the file.
 *
 * `width` and `height` are what a browser reserves before a lazy image has
 * arrived. They used to be one guess for every desktop shot and one for every
 * phone shot, and the shots are all different heights - so the page reserved a
 * short box, the image arrived three times as tall, and everything under it
 * jumped. Read here, a missing file also stops the build rather than
 * publishing a broken image.
 */
function image(locale, name, theme, alt, width) {
  const file = `${name}-${theme}.webp`;
  const size = webpSize(join(screenshots, locale, file));
  return raw(`<img class="${width} ${theme}" src="/img/${locale}/${file}" alt="${escapeAttribute(alt)}" width="${size.width}" height="${size.height}" loading="lazy" decoding="async">`);
}

/** How tall a screenshot is for its width, from its light copy. */
export function aspect(locale, name) {
  const size = webpSize(join(screenshots, locale, `${name}-light.webp`));
  return size.height / size.width;
}

/** The pixel size of a WebP file, from its header. */
export function webpSize(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`Missing screenshot: ${path}`);
  }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`Not a WebP file: ${path}`);
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  throw new Error(`Unknown WebP layout ${JSON.stringify(chunk)}: ${path}`);
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
