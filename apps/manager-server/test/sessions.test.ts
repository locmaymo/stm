import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { clearSessionCookie, parseSessionCookie, SessionStore, sessionCookie } from '../src/sessions.js';

test('sessions are opaque, expire, and revoke', () => {
  let now = 1_000;
  const sessions = new SessionStore({ now: () => now, ttlMs: 100 });
  const created = sessions.create();
  assert.notEqual(created.token, created.session.csrfToken);
  assert.equal(sessions.get(created.token)?.csrfToken, created.session.csrfToken);
  now = 1_101;
  assert.equal(sessions.get(created.token), null);

  const second = sessions.create();
  sessions.revoke(second.token);
  assert.equal(sessions.get(second.token), null);
});

test('cookies parse and include browser security attributes', () => {
  const cookie = sessionCookie('token-value', false);
  assert.equal(parseSessionCookie(`${cookie}; other=value`), 'token-value');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
});

test('a console read over HTTPS gets a cookie a frame can keep', () => {
  // Read inside another site's frame, the console is a third party to the page
  // around it, and SameSite=Lax is exactly what a browser withholds there: the
  // password is accepted and the next request arrives with no session at all.
  const cookie = sessionCookie('token-value', true);
  assert.equal(parseSessionCookie(cookie), 'token-value');
  assert.match(cookie, /SameSite=None/);
  // Which browsers accept only together with Secure, so the two never separate.
  assert.match(cookie, /Secure/);
  assert.match(clearSessionCookie(true), /SameSite=None; Secure/);
  // A cookie set one way has to be cleared the same way, or signing out sets a
  // second cookie beside the first instead of replacing it.
  assert.match(clearSessionCookie(false), /SameSite=Lax/);
  assert.doesNotMatch(clearSessionCookie(false), /Secure/);
});

test('rate limiter blocks after the configured attempts', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.check('client').allowed, true);
  assert.equal(limiter.check('client').allowed, true);
  const blocked = limiter.check('client');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  now = 1_001;
  assert.equal(limiter.check('client').allowed, true);
});
