import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText, failureText, readFailure } from '../src/api-error.js';
import { failures } from '../src/i18n.js';

const catalog = { installation_busy: 'Chờ lượt cài kia xong đã.' };

test('a code the manager knows is said in the reader’s language', () => {
  const failure = readFailure({ error: { code: 'installation_busy', message: 'Another installation is running' } });
  assert.equal(failureText(failure, catalog, 'fallback'), 'Chờ lượt cài kia xong đã.');
});

test('a code the manager does not know keeps the server’s own sentence', () => {
  // Output from git, npm or SillyTavern is that program's words. Translating
  // it would make it impossible to search for, and is not ours to reword.
  const failure = readFailure({ error: { code: 'git_failed', message: 'fatal: repository not found' } });
  assert.equal(failureText(failure, catalog, 'fallback'), 'fatal: repository not found');
});

test('a body with nothing readable in it falls back to what the caller would have said', () => {
  for (const payload of [null, undefined, 'gateway timeout', {}, { error: {} }, { error: { message: '' } }]) {
    assert.equal(failureText(readFailure(payload), catalog, 'Could not save'), 'Could not save', JSON.stringify(payload));
  }
});

test('a stored failure is read the same way as one that just arrived', () => {
  assert.equal(errorText('installation_busy', 'Another installation is running', catalog, 'fallback'), 'Chờ lượt cài kia xong đã.');
  assert.equal(errorText(undefined, 'npm ERR! code ELIFECYCLE', catalog, 'fallback'), 'npm ERR! code ELIFECYCLE');
  assert.equal(errorText(undefined, null, catalog, 'fallback'), 'fallback');
});

test('the real catalogue answers in both languages, and neither answers in the other', () => {
  const body = { error: { code: 'installation_required', message: 'Install SillyTavern before editing its configuration' } };
  const english = failures('en').body(body, 'fallback');
  const vietnamese = failures('vi').body(body, 'fallback');
  assert.equal(english, 'Install SillyTavern first.');
  assert.notEqual(vietnamese, english);
  assert.notEqual(vietnamese, body.error.message);
});
