export type LocaleCode = 'en' | 'vi';
export type ThemeMode = 'light' | 'dark';
export type Preferences = { locale: LocaleCode; theme: ThemeMode };

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readPreferences(storage?: PreferenceStorage): Preferences {
  try {
    const locale = storage?.getItem('stm-locale');
    const theme = storage?.getItem('stm-theme');
    return { locale: locale === 'vi' ? 'vi' : 'en', theme: theme === 'light' ? 'light' : 'dark' };
  } catch {
    return { locale: 'en', theme: 'dark' };
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
