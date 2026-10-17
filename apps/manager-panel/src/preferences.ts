export type LocaleCode = 'en' | 'vi';
export type ThemeMode = 'light' | 'dark';
export type Preferences = { locale: LocaleCode; theme: ThemeMode };

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** What the browser says it is set to, for the first visit only. */
export interface EnvironmentHints {
  readonly languages?: readonly string[];
  readonly timeZone?: string;
  readonly prefersLight?: boolean;
}

const VIETNAMESE_TIME_ZONES: ReadonlySet<string> = new Set([
  'Asia/Ho_Chi_Minh',
  'Asia/Saigon',
]);

/**
 * The locale to open with when nothing has been chosen yet.
 *
 * Most of the people this manager is for read Vietnamese. On phones they
 * usually set the system or browser language to Vietnamese; on Windows desktops
 * in Vietnam almost everyone runs an English OS (`en-US`) while the machine's
 * region and timezone are set to Vietnam (`Asia/Saigon` / `Asia/Ho_Chi_Minh`).
 * An explicit choice is still stored and still wins on every later visit.
 */
export function preferredLocale(languages: readonly string[] = [], timeZone?: string): LocaleCode {
  if (timeZone && VIETNAMESE_TIME_ZONES.has(timeZone)) return 'vi';
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'vi') return 'vi';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function readPreferences(storage?: PreferenceStorage, environment: EnvironmentHints = {}): Preferences {
  const fallback: Preferences = {
    locale: preferredLocale(environment.languages ?? [], environment.timeZone),
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
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      prefersLight: window.matchMedia('(prefers-color-scheme: light)').matches,
    };
  } catch {
    return {};
  }
}
