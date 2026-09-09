import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreferences, savePreferences } from '../src/preferences.js';

test('preferences accept only supported locale and theme values', () => {
  const values = new Map<string, string>([['stm-locale', 'fr'], ['stm-theme', 'sepia']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.deepEqual(readPreferences(storage), { locale: 'en', theme: 'dark' });
  savePreferences({ locale: 'vi', theme: 'light' }, storage);
  assert.equal(values.get('stm-locale'), 'vi');
  assert.equal(values.get('stm-theme'), 'light');
});
