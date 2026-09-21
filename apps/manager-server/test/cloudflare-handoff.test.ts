import test from 'node:test';
import assert from 'node:assert/strict';
import { HandoffStore } from '../src/cloudflare-handoff.js';

const result = { outcome: 'signed_in', code: '', sessionToken: 'a-session' } as const;

test('a sign-in is named, left, and collected once', () => {
  const store = new HandoffStore();
  const secret = store.open('state-1');
  assert.notEqual(secret, 'state-1', 'the name is not the state, which the browser has seen');
  assert.equal(store.isOpen('state-1'), true);
  assert.equal(store.isOpen('state-2'), false);

  // Nothing to collect until the callback has been through.
  assert.deepEqual(store.claim(secret), { status: 'waiting' });

  store.settle('state-1', result);
  assert.deepEqual(store.claim(secret), { status: 'ready', result });

  // Spent. Whoever asks next is told to stop asking rather than handed the
  // session a second time.
  assert.equal(store.claim(secret), null);
});

test('a name nobody issued collects nothing', () => {
  const store = new HandoffStore();
  store.open('state-1');
  assert.equal(store.claim('not-a-name'), null);
  assert.equal(store.claim(''), null);
});

test('an answer for a sign-in nobody is waiting on is dropped', () => {
  const store = new HandoffStore();
  // The ordinary case: a console that can send itself to Cloudflare reads the
  // outcome in its own address and asked for no name at all.
  store.settle('state-nobody-named', result);
  assert.equal(store.isOpen('state-nobody-named'), false);
});

test('a sign-in left too long is gone, session and all', () => {
  let now = 1_000;
  const store = new HandoffStore({ now: () => now, ttlMs: 100 });
  const secret = store.open('state-1');
  store.settle('state-1', result);
  now = 1_101;
  assert.equal(store.claim(secret), null);
  assert.equal(store.isOpen('state-1'), false);
});

test('sign-ins started and abandoned do not pile up', () => {
  const store = new HandoffStore();
  const secrets = Array.from({ length: 12 }, (_, index) => store.open(`state-${index}`));
  // The oldest give way to the newest, which are the ones still being waited on.
  assert.equal(store.claim(secrets[0]!), null);
  assert.deepEqual(store.claim(secrets[11]!), { status: 'waiting' });
});

test('each sign-in is collected under its own name', () => {
  const store = new HandoffStore();
  const first = store.open('state-1');
  const second = store.open('state-2');
  store.settle('state-2', result);
  assert.deepEqual(store.claim(first), { status: 'waiting' });
  assert.deepEqual(store.claim(second), { status: 'ready', result });
});
