import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import type { LocaleCode } from './preferences.js';

type LeafKeys<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafKeys<T[K]>}` }[keyof T & string];
export type MessageKey = LeafKeys<typeof en>;
export type Translate = (key: MessageKey) => string;

export function translator(locale: LocaleCode): Translate {
  const dictionary = locale === 'vi' ? vi : en;
  return (key) => {
    let current: unknown = dictionary;
    for (const part of key.split('.')) {
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === 'string' ? current : key;
  };
}
