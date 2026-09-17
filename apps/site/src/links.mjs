import { escape, raw, text } from './html.mjs';

/**
 * Prose and paths, resolved against the language being read.
 *
 * Content is written with site-root paths - `/docs`, `/privacy`, `#windows` -
 * and never with a language in them. The Vietnamese pages live under `/vi`, so
 * the prefix is added here, at render time. Keeping it out of the content
 * means neither language carries the other's prefix, a translation cannot
 * accidentally send a reader back into English, and moving a language to a
 * different root is one change rather than two hundred.
 */

/** A site-root path, under the locale it is being rendered for. */
export function localePath(path, root) {
  if (!root || !path.startsWith('/') || path.startsWith('//')) return path;
  return `${root}${path}`;
}

/** One paragraph of prose, with its `[label](/path)` links given the prefix. */
export function prose(value, root) {
  const rendered = text(value);
  if (!root) return rendered;
  return raw(String(rendered).replace(/href="\/(?!\/)/g, `href="${escape(root)}/`));
}
