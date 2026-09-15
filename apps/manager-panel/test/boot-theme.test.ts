import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPreferences } from '../src/preferences.js';

const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

/**
 * Run the one decision `index.html` makes before anything is painted.
 *
 * The script cannot import `preferences.ts` - it runs before the bundle - so
 * the same rule is written twice. This reads the real script out of the real
 * file and runs it, so the copy cannot quietly drift from the original.
 */
function bootTheme(stored: string | null, prefersLight: boolean): 'light' | 'dark' {
  const script = /<script>([\s\S]*?)<\/script>/u.exec(indexHtml)?.[1];
  assert.ok(script, 'index.html has a script before the stylesheet');
  let dark = false;
  const element = { classList: { toggle: (_name: string, value: boolean) => { dark = value; }, add: () => { dark = true; } } };
  const window = {
    localStorage: { getItem: (key: string) => key === 'stm-theme' ? stored : null },
    matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: light)' ? prefersLight : false }),
  };
  new Function('window', 'document', script)(window, { documentElement: element });
  return dark ? 'dark' : 'light';
}

test('the page picks the theme the app would have picked', () => {
  const storage = (theme: string | null) => ({ getItem: (key: string) => key === 'stm-theme' ? theme : null, setItem: () => undefined });
  for (const stored of [null, 'dark', 'light']) {
    for (const prefersLight of [true, false]) {
      const app = readPreferences(storage(stored), { prefersLight }).theme;
      assert.equal(bootTheme(stored, prefersLight), app, `stored ${String(stored)}, prefers light ${String(prefersLight)}`);
    }
  }
});

test('a browser that refuses storage still gets a page, in the dark theme', () => {
  const script = /<script>([\s\S]*?)<\/script>/u.exec(indexHtml)?.[1];
  assert.ok(script);
  let dark: boolean | null = null;
  const element = { classList: { toggle: (_name: string, value: boolean) => { dark = value; }, add: () => { dark = true; } } };
  const window = { localStorage: { getItem: () => { throw new Error('blocked'); } }, matchMedia: () => ({ matches: false }) };
  new Function('window', 'document', script)(window, { documentElement: element });
  // Dark is what `readPreferences` falls back to as well, and a dark page that
  // turns out to be wrong is kinder at night than a white one.
  assert.equal(dark, true);
});

test('the boot screen is in the page and is hidden from a screen reader', () => {
  assert.ok(indexHtml.includes('id="boot"'));
  assert.ok(/<div id="boot"[^>]*aria-hidden="true"/u.test(indexHtml));
});
