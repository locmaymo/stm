import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import type { MessageParams } from '../../../packages/contracts/src/index.js';
import { interpolate } from '../../../packages/contracts/src/index.js';
import { errorText, failureText, readFailure } from './api-error.js';
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
  return section(locale, 'logs');
}

/**
 * The `errors.*` catalogue for one locale.
 *
 * Read by code the same way log lines are: the server names the failure and
 * the panel decides what that is called here. A code with no entry falls back
 * to the server's own sentence.
 */
export function errorCatalog(locale: LocaleCode): Record<string, unknown> {
  return section(locale, 'errors');
}

function section(locale: LocaleCode, name: string): Record<string, unknown> {
  const value = dictionaryFor(locale)[name];
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

/**
 * How a failure is turned into a sentence, threaded the way `t` is.
 *
 * Two shapes, because failures arrive two ways: an API error body, and a code
 * and message stored on a record that failed earlier. Both end at the same
 * catalogue, so a refusal reads the same wherever it is met.
 */
export interface Fail {
  /** From an API error body: `{ error: { code, message } }`. */
  readonly body: (payload: unknown, fallback: string) => string;
  /** From a stored failure, such as an installation's or the process's. */
  readonly of: (code: string | null | undefined, message: string | null, fallback: string) => string;
}

export function failures(locale: LocaleCode): Fail {
  const catalog = errorCatalog(locale);
  return {
    body: (payload, fallback) => failureText(readFailure(payload), catalog, fallback),
    of: (code, message, fallback) => errorText(code, message, catalog, fallback),
  };
}
