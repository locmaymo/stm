import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCESS_LINKS, parseAccessLinks } from '../src/index.js';

test('each door has its own first address until the reader picks one', () => {
  // SillyTavern loads hundreds of files, so the faster tunnel address goes
  // first; the console loads a handful, and keeps the address that lasts.
  assert.deepEqual(parseAccessLinks(null), DEFAULT_ACCESS_LINKS);
  assert.equal(DEFAULT_ACCESS_LINKS.sillyTavern.preferred, 'tunnel');
  assert.equal(DEFAULT_ACCESS_LINKS.manager.preferred, 'fixed');
  const picked = parseAccessLinks({ sillyTavern: { preferred: 'fixed', showFixed: true, chosen: true }, manager: { preferred: 'tunnel', showFixed: true, chosen: true } });
  assert.equal(picked.sillyTavern.preferred, 'fixed');
  assert.equal(picked.manager.preferred, 'tunnel');
});

test('a preference written before choices were marked is read for what it was', () => {
  // `fixed` was everybody's default then, so it says nothing; `tunnel` could
  // only have been picked.
  const old = parseAccessLinks({ sillyTavern: { preferred: 'fixed', showFixed: true }, manager: { preferred: 'tunnel', showFixed: false } });
  assert.deepEqual(old.sillyTavern, { preferred: 'tunnel', showFixed: true, chosen: false });
  assert.deepEqual(old.manager, { preferred: 'tunnel', showFixed: false, chosen: true });
  // Written since, an unpicked door is marked as such and follows the default.
  assert.deepEqual(parseAccessLinks({ sillyTavern: { preferred: 'tunnel', showFixed: true, chosen: false } }).sillyTavern, DEFAULT_ACCESS_LINKS.sillyTavern);
});
