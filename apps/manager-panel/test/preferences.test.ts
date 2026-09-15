import test from 'node:test';
import assert from 'node:assert/strict';
import { preferredLocale, readPreferences, savePreferences } from '../src/preferences.js';

test('preferences accept only supported locale and theme values', () => {
  const values = new Map<string, string>([['stm-locale', 'fr'], ['stm-theme', 'sepia']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.deepEqual(readPreferences(storage), { locale: 'en', theme: 'dark' });
  savePreferences({ locale: 'vi', theme: 'light' }, storage);
  assert.equal(values.get('stm-locale'), 'vi');
  assert.equal(values.get('stm-theme'), 'light');
});

test('the browser decides the first visit and a stored choice decides every later one', () => {
  const empty = { getItem: () => null, setItem: () => undefined };
  assert.deepEqual(
    readPreferences(empty, { languages: ['vi-VN', 'en-US'], prefersLight: true }),
    { locale: 'vi', theme: 'light' },
  );
  const chosen = new Map<string, string>([['stm-locale', 'en'], ['stm-theme', 'dark']]);
  assert.deepEqual(
    readPreferences({ getItem: (key: string) => chosen.get(key) ?? null, setItem: () => undefined }, { languages: ['vi'], prefersLight: true }),
    { locale: 'en', theme: 'dark' },
  );
});

test('an unreadable or unrelated browser language falls back to English', () => {
  assert.equal(preferredLocale([]), 'en');
  assert.equal(preferredLocale(['fr-FR', 'de']), 'en');
  assert.equal(preferredLocale(['en-GB', 'vi']), 'en');
  assert.equal(preferredLocale(['VI-vn']), 'vi');
});
