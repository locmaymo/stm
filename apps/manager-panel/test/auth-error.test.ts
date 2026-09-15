import assert from 'node:assert/strict';
import test from 'node:test';
import { authErrorKey } from '../src/auth-error.js';
import { translator } from '../src/i18n.js';

test('every refusal the sign-in screen can meet has a translation', () => {
  // These are the codes `handleLogin` and `handlePasswordSetup` answer with.
  const codes = [
    'invalid_credentials', 'invalid_password',
    'notice_acceptance_required', 'already_configured', 'setup_required', 'rate_limited',
  ];
  const en = translator('en');
  const vi = translator('vi');
  for (const code of codes) {
    const key = authErrorKey(code);
    assert.ok(key, `no message for ${code}`);
    // A key that resolves to itself is a key with nothing behind it.
    assert.notEqual(en(key), key, `english missing for ${code}`);
    assert.notEqual(vi(key), key, `vietnamese missing for ${code}`);
    assert.notEqual(en(key), vi(key), `untranslated for ${code}`);
  }
});

test('an unfamiliar refusal leaves the server to speak for itself', () => {
  assert.equal(authErrorKey('some_new_code'), null);
  assert.equal(authErrorKey(undefined), null);
  assert.equal(authErrorKey(null), null);
  assert.equal(authErrorKey(42), null);
});
