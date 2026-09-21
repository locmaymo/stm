import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUDFLARE_RESULT, cloudflareOutcome, isReturnWindow, readCloudflareResult } from '../src/oauth.js';

test('the outcome is read from the address the manager sent the browser back to', () => {
  assert.deepEqual(cloudflareOutcome('?cloudflare=signed_in'), { outcome: 'signed_in', code: '' });
  assert.deepEqual(cloudflareOutcome('?cloudflare=connected'), { outcome: 'connected', code: '' });
  assert.deepEqual(cloudflareOutcome('?cloudflare=error&cloudflare_error=login_required'), { outcome: 'error', code: 'login_required' });
});

test('an address that says nothing about a sign-in is not one', () => {
  assert.equal(cloudflareOutcome(''), null);
  assert.equal(cloudflareOutcome('?tab=data'), null);
  // Anything the manager does not send is not an outcome, whoever put it there.
  assert.equal(cloudflareOutcome('?cloudflare=yes'), null);
  assert.equal(cloudflareOutcome('?cloudflare='), null);
});

test('a window with no opener has nobody to hand anything to', () => {
  assert.equal(isReturnWindow({ opener: null }), false);
  assert.equal(isReturnWindow({ opener: {} }), true);
  const self = { opener: null as unknown };
  self.opener = self;
  assert.equal(isReturnWindow(self as { opener: unknown }), false);
});

test('a result carries the session, so the console waiting for it becomes signed in', () => {
  const read = readCloudflareResult({ type: CLOUDFLARE_RESULT, outcome: 'signed_in', code: '', session: { csrfToken: 'csrf', token: 'session-token' } });
  assert.deepEqual(read, { type: CLOUDFLARE_RESULT, outcome: 'signed_in', code: '', session: { csrfToken: 'csrf', token: 'session-token' } });
});

test('anything else arriving on the same wire is not a result', () => {
  // Every page in a frame hears from whatever is around it, and a console
  // that took any of it for a sign-in would sign itself in on request.
  assert.equal(readCloudflareResult(null), null);
  assert.equal(readCloudflareResult('stm:cloudflare-result'), null);
  assert.equal(readCloudflareResult({ outcome: 'signed_in' }), null);
  assert.equal(readCloudflareResult({ type: 'webpackHotUpdate' }), null);
  assert.equal(readCloudflareResult({ type: CLOUDFLARE_RESULT, outcome: 'whatever' }), null);
});

test('a half-written session is no session at all', () => {
  // Rather than a console that thinks it is signed in and holds nothing to
  // prove it, which is a sign-in screen that will not come back.
  for (const session of [null, 'token', { csrfToken: 'csrf' }, { token: 'session-token' }, { csrfToken: 1, token: 2 }]) {
    const read = readCloudflareResult({ type: CLOUDFLARE_RESULT, outcome: 'signed_in', code: '', session });
    assert.equal(read?.session, undefined);
  }
});
