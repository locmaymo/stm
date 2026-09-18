import test from 'node:test';
import assert from 'node:assert/strict';
import en from '../../../packages/ui/locales/en.json' with { type: 'json' };
import vi from '../../../packages/ui/locales/vi.json' with { type: 'json' };
import { translator } from '../src/i18n.js';

test('a value can be dropped into a string, in either language', () => {
  assert.equal(translator('en')('console.installConfirm', { version: '1.19.0' }), 'Install 1.19.0?');
  assert.equal(translator('vi')('console.installConfirm', { version: '1.19.0' }), 'Cài 1.19.0?');
});

test('a string with nothing to fill in is returned as it is', () => {
  const t = translator('en');
  assert.equal(t('common.cancel'), 'Cancel');
  // Passing values a string does not use changes nothing.
  assert.equal(t('common.cancel', { version: 'ignored' }), 'Cancel');
});

test('a placeholder with no value is left visible rather than blanked', () => {
  // Better a reader sees "{version}" and can say so than a sentence with a
  // hole in it that reads as if it were complete.
  assert.equal(translator('en')('console.installConfirm'), 'Install {version}?');
});

test('both languages fill the same holes', () => {
  // The encoding gate checks this across every key. This pins the two callers
  // that pass values, where a mismatch shows as a literal brace on screen.
  const placeholders = (value: string) => [...value.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]).sort();
  for (const key of ['console.installConfirm', 'console.restoreTitle', 'console.restoreCounts', 'console.deleteBackupTitle', 'table.count', 'table.page', 'logs.install.resolved'] as const) {
    assert.deepEqual(placeholders(translator('en')(key)), placeholders(translator('vi')(key)), key);
  }
});

test('no message writes a port number into the sentence', () => {
  // 8000, 8001 and 7860 were spelt out in six messages. All three can move now
  // - SillyTavern's from the panel, the other two from the environment - so a
  // number in the text is a line that will one day be wrong. A message that
  // names a port takes it as a value instead.
  const moveable = new Set(['7860', '8000', '8001']);
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const [, digits] of node.matchAll(/(?<![\w.])(\d{4,5})(?![\w.])/gu)) {
        if (digits !== undefined && moveable.has(digits)) offenders.push(`${path}: ${node}`);
      }
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
  };
  walk(en, 'en');
  walk(vi, 'vi');
  assert.deepEqual(offenders, []);
});
