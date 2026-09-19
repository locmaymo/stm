import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeState } from '../../../packages/cloudflare/src/oauth.js';
// @ts-expect-error The relay is plain browser JavaScript with no type declarations.
import { decide, isUsualManagerHost, originFromState } from '../../../apps/site/public/relay.js';
// @ts-expect-error The page script is plain browser JavaScript with no type declarations.
import { preferredLocale } from '../../../apps/site/public/assets/relay-page.js';

test('the relay reads the origin the manager put in state', () => {
  assert.equal(originFromState(encodeState('http://127.0.0.1:7860/some/page')), 'http://127.0.0.1:7860');
  assert.equal(originFromState(encodeState('https://blue-sky.trycloudflare.com')), 'https://blue-sky.trycloudflare.com');
  assert.equal(originFromState('not-a-state-at-all'), null);
  assert.equal(originFromState(Buffer.from(JSON.stringify({ n: 'x', o: 'javascript:alert(1)' })).toString('base64url')), null);
  assert.equal(originFromState(Buffer.from(JSON.stringify({ n: 'x', o: 'https://user:pass@example.com' })).toString('base64url')), null);
  assert.equal(originFromState(Buffer.from(JSON.stringify({ o: 'https://example.com' })).toString('base64url')), null);
});

test('the code, state and error go to the manager\'s callback, and nothing else does', () => {
  const state = encodeState('http://localhost:7860');
  const decision = decide(`?code=abc&state=${state}&extra=evil`);
  assert.equal(decision.kind, 'forward');
  const url = new URL(decision.url);
  assert.equal(`${url.origin}${url.pathname}`, 'http://localhost:7860/oauth/cloudflare/callback');
  assert.deepEqual(Object.fromEntries(url.searchParams), { code: 'abc', state });
  assert.equal(decision.automatic, true);

  const denied = decide(`?error=access_denied&error_description=No&state=${state}`);
  assert.deepEqual(Object.fromEntries(new URL(denied.url).searchParams), { state, error: 'access_denied', error_description: 'No' });
});

test('a query that did not come from a manager sign-in goes nowhere', () => {
  assert.deepEqual(decide(''), { kind: 'invalid' });
  assert.deepEqual(decide('?code=abc'), { kind: 'invalid' });
  assert.deepEqual(decide(`?state=${encodeState('http://localhost:7860')}`), { kind: 'invalid' });
});

test('usual manager addresses forward at once; anything else waits for a click', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.1.5', '100.101.102.103', 'nas.local', '[::1]', 'blue-sky.trycloudflare.com', 'locmay-stm.ms.fun', 'www.modelscope.ai']) {
    assert.equal(isUsualManagerHost(host), true, host);
  }
  for (const host of ['evil.example', '172.32.0.1', '8.8.8.8', 'trycloudflare.com.evil.example', 'modelscope.ai.evil.example']) {
    assert.equal(isUsualManagerHost(host), false, host);
  }
  const custom = decide(`?code=abc&state=${encodeState('https://tavern.example.com')}`);
  assert.equal(custom.automatic, false);
  assert.equal(custom.host, 'tavern.example.com');
});

test('the callback page opens in the language the reader has already chosen', () => {
  /*
   * This page's address is registered on the OAuth client and Cloudflare
   * returns to it matched exactly, so it cannot be a Vietnamese URL the way
   * every other page on the site is. It printed both languages at once
   * instead. Now it picks one, and `stm-locale` - the key the site's own
   * language switch writes, on this same origin - is what it picks by.
   */
  assert.equal(preferredLocale('vi', ['en-US']), 'vi');
  assert.equal(preferredLocale('en', ['vi-VN']), 'en');

  // Nothing chosen here before: follow the browser, which for a Vietnamese
  // reader is very often already the right answer.
  assert.equal(preferredLocale(null, ['vi-VN', 'en-US']), 'vi');
  assert.equal(preferredLocale(null, ['en-GB']), 'en');

  // Anything else is not an answer, and English is the one the page ships in.
  assert.equal(preferredLocale('fr', ['fr-FR']), 'en');
  assert.equal(preferredLocale(null, []), 'en');
  assert.equal(preferredLocale(null, undefined), 'en');
});
