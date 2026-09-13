import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import type { LocaleCode } from './preferences.js';

type LeafKeys<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafKeys<T[K]>}` }[keyof T & string];
export type MessageKey = LeafKeys<typeof en>;
export type Translate = (key: MessageKey) => string;

function dictionaryFor(locale: LocaleCode): Record<string, unknown> {
  return (locale === 'vi' ? vi : en) as Record<string, unknown>;
}

export function translator(locale: LocaleCode): Translate {
  const dictionary = dictionaryFor(locale);
  return (key) => {
    let current: unknown = dictionary;
    for (const part of key.split('.')) {
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === 'string' ? current : key;
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
