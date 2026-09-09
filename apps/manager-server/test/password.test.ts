import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, validatePassword, verifyPassword } from '../src/password.js';

test('password hashes verify without storing the clear text', () => {
  const password = 'correct horse battery staple';
  const encoded = hashPassword(password);
  assert.match(encoded, /^scrypt\$/);
  assert.notEqual(encoded, password);
  assert.equal(verifyPassword(password, encoded), true);
  assert.equal(verifyPassword('wrong password', encoded), false);
});

test('password policy rejects short and non-string values', () => {
  assert.equal(validatePassword('short'), 'Password must be at least 12 characters');
  assert.equal(validatePassword(undefined), 'Password is required');
  assert.equal(validatePassword('a'.repeat(257)), 'Password is too long');
  assert.equal(validatePassword('long enough password'), null);
});
