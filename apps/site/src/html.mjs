/**
 * The smallest set of helpers a hand-built static site needs.
 *
 * There is no template engine here on purpose. The site is a handful of pages
 * assembled from content files, and a dependency that renders HTML would be a
 * larger thing to keep working than the HTML it renders. What is needed is an
 * escape that is applied by default and a way to say "this is already markup".
 */

/** Text that has already been escaped, or was written as markup deliberately. */
export class Raw {
  constructor(value) {
    this.value = String(value);
  }

  toString() {
    return this.value;
  }
}

/** Mark a string as markup, so `html` will not escape it again. */
export function raw(value) {
  return new Raw(value);
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * A tagged template that escapes every interpolation except `Raw` and arrays
 * of `Raw`, which is the only way markup gets in.
 */
export function html(strings, ...values) {
  let result = strings[0] ?? '';
  for (const [index, value] of values.entries()) {
    result += render(value) + (strings[index + 1] ?? '');
  }
  return new Raw(result);
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(value);
}

/** Join rendered pieces with a separator, for lists built by `map`. */
export function join(pieces, separator = '\n') {
  return raw(pieces.map((piece) => (piece instanceof Raw ? piece.value : escape(piece))).join(separator));
}

/**
 * Turn a paragraph of plain text into markup, honouring three conventions.
 *
 * The content files are prose, and prose needs `code`, emphasis and links
 * without becoming a Markdown pipeline: `` `like this` `` is code, `**bold**`
 * is strong, and `[label](href)` is a link. Everything else is escaped, so a
 * sentence with an ampersand in it stays a sentence.
 */
export function text(value) {
  const escaped = escape(value);
  return raw(escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const external = /^https?:/.test(href);
      const attributes = external ? ' target="_blank" rel="noreferrer noopener"' : '';
      return `<a href="${href}"${attributes}>${label}</a>`;
    }));
}

/** Several paragraphs of `text`, each in its own `<p>`. */
export function paragraphs(values, className) {
  const attribute = className ? ` class="${escape(className)}"` : '';
  return join(values.map((value) => raw(`<p${attribute}>${text(value)}</p>`)));
}
