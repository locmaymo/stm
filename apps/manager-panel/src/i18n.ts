import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import type { MessageParams } from '../../../packages/contracts/src/index.js';
import { interpolate } from './log-format.js';
import type { LocaleCode } from './preferences.js';

type LeafKeys<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafKeys<T[K]>}` }[keyof T & string];
export type MessageKey = LeafKeys<typeof en>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;

function dictionaryFor(locale: LocaleCode): Record<string, unknown> {
  return (locale === 'vi' ? vi : en) as Record<string, unknown>;
}

export function translator(locale: LocaleCode): Translate {
  const dictionary = dictionaryFor(locale);
  return (key, params) => {
    let current: unknown = dictionary;
    for (const part of key.split('.')) {
      current = (current as Record<string, unknown>)[part];
    }
    // The same `{name}` substitution the log catalog uses, rather than a
    // second mechanism for the same job. A string with no placeholders is
    // returned untouched, so passing nothing stays the common case.
    return typeof current === 'string' ? interpolate(current, params) : key;
  };
}

/**
 * The `logs.*` catalog for one locale.
 *
 * Log lines and progress steps are looked up by a code the server sends rather
 * than by a key known at build time, so they need the raw dictionary instead of
 * the typed translator.
 */
export function logCatalog(locale: LocaleCode): Record<string, unknown> {
  const logs = dictionaryFor(locale).logs;
  return typeof logs === 'object' && logs !== null ? logs as Record<string, unknown> : {};
}
