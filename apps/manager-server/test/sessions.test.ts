import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { parseSessionCookie, SessionStore, sessionCookie } from '../src/sessions.js';

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
