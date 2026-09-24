import type { LogEntry, MessageParams } from './index.js';

/**
 * Text as a search compares it: one Unicode form, no case, no accents.
 *
 * Vietnamese keyboards write the same letter two ways - precomposed, or a
 * base letter followed by its marks - and the catalogue is written in the
 * first, so a search typed in the second used to find nothing at all. Folding
 * the marks away as well lets "cong" find "cổng", which is how people search
 * when they cannot be bothered to type the tones.
 */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{Mn}+/gu, '').replace(/đ/gu, 'd').replace(/Đ/gu, 'D').toLocaleLowerCase();
}

/** Remove the internal job prefix from messages before showing them to operators. */
export function formatLogMessage(message: string): string {
  return message.replace(/^\[(?:manager|sillytavern|cloudflared|installer|backup|config|profiles|r2|setup|telemetry)(?::[a-z0-9-]{16,})?\] ?/i, '');
}

/** Substitute `{name}` placeholders with the values the server sent. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{([^{}]+)\}/gu, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * A log line in the reader's language.
 *
 * Only lines the manager wrote itself carry a catalog code. Output from
 * SillyTavern, cloudflared, npm and git arrives without one and is shown
 * exactly as that program wrote it - translating another project's output
 * would make it impossible to search for.
 */
export function translateLogEntry(entry: LogEntry, catalog: Record<string, unknown>): string {
  const template = entry.code === undefined ? undefined : lookup(catalog, entry.code);
  return template === undefined
    ? formatLogMessage(entry.message)
    : interpolate(template, entry.params);
}

/** The translation for a manager step, or its English text when there is none. */
export function translateStep(step: string, catalog: Record<string, unknown>, code?: string, params?: MessageParams): string {
  const template = code === undefined ? undefined : lookup(catalog, code);
  return template === undefined ? step : interpolate(template, params);
}

function lookup(catalog: Record<string, unknown>, code: string): string | undefined {
  let current: unknown = catalog;
  for (const part of code.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}
