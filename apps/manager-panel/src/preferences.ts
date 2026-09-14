export type LocaleCode = 'en' | 'vi';
export type ThemeMode = 'light' | 'dark';
export type Preferences = { locale: LocaleCode; theme: ThemeMode };

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** What the browser says it is set to, for the first visit only. */
export interface EnvironmentHints {
  readonly languages?: readonly string[];
  readonly prefersLight?: boolean;
}

/**
 * The locale to open with when nothing has been chosen yet.
 *
 * Most of the people this manager is for read Vietnamese and set their phone
 * or browser to it; opening in English and leaving them to find a two-letter
 * toggle in the top bar is a worse first minute than simply believing what the
 * browser already says. An explicit choice is still stored and still wins.
 */
export function preferredLocale(languages: readonly string[] = []): LocaleCode {
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'vi') return 'vi';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function readPreferences(storage?: PreferenceStorage, environment: EnvironmentHints = {}): Preferences {
  const fallback: Preferences = {
    locale: preferredLocale(environment.languages ?? []),
    theme: environment.prefersLight === true ? 'light' : 'dark',
  };
  try {
    const locale = storage?.getItem('stm-locale');
    const theme = storage?.getItem('stm-theme');
    return {
      locale: locale === 'vi' ? 'vi' : locale === 'en' ? 'en' : fallback.locale,
      theme: theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : fallback.theme,
    };
  } catch {
    return fallback;
  }
}

export function savePreferences(preferences: Preferences, storage?: PreferenceStorage): void {
  try {
    storage?.setItem('stm-locale', preferences.locale);
    storage?.setItem('stm-theme', preferences.theme);
  } catch {
    // The selected appearance still works when browser storage is unavailable.
  }
}

export function browserStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The hints the running browser offers, guarded so tests and SSR stay simple. */
export function browserEnvironment(): EnvironmentHints {
  try {
    return {
      languages: navigator.languages ?? (navigator.language ? [navigator.language] : []),
      prefersLight: window.matchMedia('(prefers-color-scheme: light)').matches,
    };
  } catch {
    return {};
  }
}
