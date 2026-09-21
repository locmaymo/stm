import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionWatch, isSessionRefusal, sessionToken, setSessionToken } from '../src/session.js';

function responder(statuses: readonly number[]) {
  let index = 0;
  const seen: RequestInit[] = [];
  return {
    seen,
    fetch: async (_input: string, init?: RequestInit) => {
      seen.push(init ?? {});
      const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
      index += 1;
      return new Response(null, { status });
    },
  };
}

test('a refusal for want of a session is a 401 and nothing else', () => {
  assert.equal(isSessionRefusal(401), true);
  // The CSRF check answers 403, and a live session can fail it on a stale
  // token. Signing the reader out over that loses a session they still have.
  assert.equal(isSessionRefusal(403), false);
  assert.equal(isSessionRefusal(200), false);
  assert.equal(isSessionRefusal(500), false);
});

test('the cookie is sent without every call site asking for it', async () => {
  const stub = responder([200]);
  const watch = createSessionWatch(stub.fetch);
  await watch.fetch('/api/v1/process');
  assert.equal(stub.seen[0]?.credentials, 'same-origin');
});

test('a call site can still set its own options', async () => {
  const stub = responder([200]);
  const watch = createSessionWatch(stub.fetch);
  await watch.fetch('/api/v1/process', { method: 'POST', headers: { 'x-csrf-token': 'abc' } });
  assert.equal(stub.seen[0]?.method, 'POST');
  assert.equal(stub.seen[0]?.credentials, 'same-origin');
});

test('the session token rides along, for a browser that keeps no cookie', async () => {
  // Inside another site's page the cookie is a third-party cookie and may
  // never be stored. The header is what keeps that console signed in.
  const stub = responder([200]);
  const watch = createSessionWatch(stub.fetch, () => 'token-value');
  await watch.fetch('/api/v1/process');
  assert.equal(new Headers(stub.seen[0]?.headers).get('authorization'), 'Bearer token-value');
});

test('a call site that set its own authorization keeps it', async () => {
  const stub = responder([200]);
  const watch = createSessionWatch(stub.fetch, () => 'token-value');
  await watch.fetch('/api/v1/process', { headers: { authorization: 'Bearer something-else' } });
  assert.equal(new Headers(stub.seen[0]?.headers).get('authorization'), 'Bearer something-else');
});

test('a console with no token sends no header at all', async () => {
  const stub = responder([200]);
  const watch = createSessionWatch(stub.fetch, () => null);
  await watch.fetch('/api/v1/process');
  assert.equal(new Headers(stub.seen[0]?.headers).has('authorization'), false);
});

test('the token is held and given up', () => {
  setSessionToken('token-value');
  assert.equal(sessionToken(), 'token-value');
  setSessionToken(null);
  assert.equal(sessionToken(), null);
});

test('a refusal throws the token away, so a reload does not present it again', async () => {
  setSessionToken('token-value');
  const stub = responder([401]);
  const watch = createSessionWatch(stub.fetch);
  await watch.fetch('/api/v1/process');
  assert.equal(sessionToken(), null);
});

test('the expiry is announced once, however many calls are refused', async () => {
  const stub = responder([401]);
  const watch = createSessionWatch(stub.fetch);
  let heard = 0;
  watch.subscribe(() => { heard += 1; });
  // The runtime poll asks for three things at a time; all three are refused at
  // the same instant, and that is one event, not three.
  await Promise.all([
    watch.fetch('/api/v1/process'),
    watch.fetch('/api/v1/tunnel'),
    watch.fetch('/api/v1/access/security'),
  ]);
  await watch.fetch('/api/v1/process');
  assert.equal(heard, 1);
  assert.equal(watch.expired(), true);
});

test('an unsubscribed console is not told', async () => {
  const stub = responder([401]);
  const watch = createSessionWatch(stub.fetch);
  let heard = 0;
  const stop = watch.subscribe(() => { heard += 1; });
  stop();
  await watch.fetch('/api/v1/process');
  assert.equal(heard, 0);
});

test('signing in again arms the watch for the next expiry', async () => {
  const stub = responder([401]);
  const watch = createSessionWatch(stub.fetch);
  let heard = 0;
  watch.subscribe(() => { heard += 1; });
  await watch.fetch('/api/v1/process');
  watch.reset();
  assert.equal(watch.expired(), false);
  await watch.fetch('/api/v1/process');
  assert.equal(heard, 2);
});

test('an ordinary response is passed through untouched', async () => {
  const stub = responder([200, 500]);
  const watch = createSessionWatch(stub.fetch);
  let heard = 0;
  watch.subscribe(() => { heard += 1; });
  assert.equal((await watch.fetch('/api/v1/process')).status, 200);
  assert.equal((await watch.fetch('/api/v1/process')).status, 500);
  assert.equal(heard, 0);
});
