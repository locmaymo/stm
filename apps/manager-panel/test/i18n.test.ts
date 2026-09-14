import test from 'node:test';
import assert from 'node:assert/strict';
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
  for (const key of ['console.installConfirm', 'logs.install.resolved'] as const) {
    assert.deepEqual(placeholders(translator('en')(key)), placeholders(translator('vi')(key)), key);
  }
});
