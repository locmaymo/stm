import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareReturn, collectCloudflareResult, isReturnWindow, popupsBlocked, savePopupsBlocked, whenAbandoned, type CollectedResult } from '../src/oauth.js';

test('the outcome is read from the address the manager sent the browser back to', () => {
  assert.deepEqual(cloudflareReturn('?cloudflare=signed_in'), { outcome: 'signed_in', code: '', collected: false });
  assert.deepEqual(cloudflareReturn('?cloudflare=connected&handoff=1'), { outcome: 'connected', code: '', collected: true });
  assert.deepEqual(cloudflareReturn('?cloudflare=error&cloudflare_error=login_required'), { outcome: 'error', code: 'login_required', collected: false });
});

test('an address that says nothing about a sign-in is not one', () => {
  assert.equal(cloudflareReturn(''), null);
  assert.equal(cloudflareReturn('?tab=data'), null);
  // Anything the manager does not send is not an outcome, whoever put it there.
  assert.equal(cloudflareReturn('?cloudflare=yes'), null);
  assert.equal(cloudflareReturn('?cloudflare='), null);
});

test('the manager saying so is what makes this a window rather than a console', () => {
  // The one signal that survives the trip. Cloudflare severs the opener on the
  // way out and the window comes home unable to tell what it is.
  const collected = cloudflareReturn('?cloudflare=signed_in&handoff=1');
  assert.equal(isReturnWindow(collected, { opener: null }), true);

  // An opener still counts, for a window this manager was never told about.
  const plain = cloudflareReturn('?cloudflare=signed_in');
  assert.equal(isReturnWindow(plain, { opener: {} }), true);
  assert.equal(isReturnWindow(plain, { opener: null }), false);

  // And a console that has not been anywhere is never held up.
  assert.equal(isReturnWindow(null, { opener: {} }), false);
});

/** A manager that answers `ready: false` a few times, then with the result. */
function manager(replies: readonly unknown[], status = 200) {
  let asked = 0;
  return {
    asked: () => asked,
    fetchImpl: (async () => {
      const body = replies[Math.min(asked, replies.length - 1)];
      asked += 1;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  };
}

/**
 * Runs the waiting at once, and only so many times.
 *
 * Bounded because a manager that never becomes ready is a poll that never
 * stops, and in a test with no clock to run out that is a hang rather than a
 * failure.
 */
function immediately(times = 4) {
  let left = times;
  return (run: () => void) => { if (left > 0) { left -= 1; run(); } };
}

async function settled(stub: ReturnType<typeof manager>): Promise<CollectedResult | null> {
  let result: CollectedResult | null = null;
  collectCloudflareResult('a-name', (value) => { result = value; }, { fetchImpl: stub.fetchImpl, wait: immediately() });
  // The loop is a chain of promises; let it run out.
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
  return result;
}

test('the answer is collected from the manager, because the window cannot bring it', async () => {
  const stub = manager([
    { ready: false },
    { ready: false },
    { ready: true, outcome: 'signed_in', code: '', session: { csrfToken: 'csrf' }, token: 'session-token' },
  ]);
  assert.deepEqual(await settled(stub), {
    outcome: 'signed_in',
    code: '',
    session: { csrfToken: 'csrf', token: 'session-token' },
  });
  // Asked until it had one, and not again afterwards.
  assert.equal(stub.asked(), 3);
});

test('an outcome with no session is carried through rather than swallowed', async () => {
  // Signing in is not the only thing that ends this way round, and a console
  // told nothing watches a spinner that has stopped meaning anything.
  const stub = manager([{ ready: true, outcome: 'error', code: 'cloudflare_not_owner' }]);
  assert.deepEqual(await settled(stub), { outcome: 'error', code: 'cloudflare_not_owner', session: null });
});

test('a half-written session is no session at all', async () => {
  // Rather than a console that believes it is signed in and holds nothing to
  // prove it, which is a sign-in screen that will not come back.
  for (const reply of [
    { ready: true, outcome: 'signed_in', session: { csrfToken: 'csrf' } },
    { ready: true, outcome: 'signed_in', token: 'session-token' },
    { ready: true, outcome: 'signed_in', session: {}, token: 'session-token' },
  ]) {
    assert.equal((await settled(manager([reply])))?.session, null);
  }
});

test('a name the manager does not know ends the asking', async () => {
  // Spent, expired, or never issued. Asking again cannot change any of those.
  const stub = manager([{ error: { code: 'not_found' } }], 404);
  assert.equal(await settled(stub), null);
  assert.equal(stub.asked(), 1);
});

test('nonsense in the answer is not an outcome', async () => {
  for (const reply of [{ ready: true }, { ready: true, outcome: 'whatever' }, { ready: 'yes', outcome: 'signed_in' }]) {
    assert.equal(await settled(manager([reply])), null);
  }
});

test('collecting stops when the console asking is done with it', async () => {
  const stub = manager([{ ready: false }]);
  const stop = collectCloudflareResult('a-name', () => assert.fail('nothing was ready'), { fetchImpl: stub.fetchImpl, wait: immediately() });
  stop();
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  assert.ok(stub.asked() <= 1, `asked ${stub.asked()} times after being stopped`);
});

/** Holds each wait until the test lets it run, so ordering is the test's. */
function queued() {
  const pending: Array<() => void> = [];
  return {
    wait: (run: () => void) => { pending.push(run); },
    run: (times = 1) => { for (let turn = 0; turn < times && pending.length > 0; turn += 1) pending.shift()!(); },
  };
}

test('a window the reader shut without finishing stops the console waiting on it', () => {
  // Otherwise the sign-in screen waits on an answer that is not coming, with
  // its buttons disabled, so they cannot start another one either.
  const clock = queued();
  let abandoned = 0;
  whenAbandoned({ closed: true } as Window, () => { abandoned += 1; }, { wait: clock.wait });
  clock.run();
  assert.equal(abandoned, 0, 'not the instant it closes: a window that finished closes too');
  clock.run();
  assert.equal(abandoned, 1);
});

test('a window still open is left alone, however long it takes', () => {
  const clock = queued();
  let abandoned = 0;
  whenAbandoned({ closed: false } as Window, () => { abandoned += 1; }, { wait: clock.wait });
  clock.run(20);
  assert.equal(abandoned, 0);
});

test('a window that closed because it finished is never called abandoned', () => {
  // It closes the moment it gets home, before the console has collected what
  // it left; collecting the answer is what stops this.
  const clock = queued();
  let abandoned = 0;
  const stop = whenAbandoned({ closed: true } as Window, () => { abandoned += 1; }, { wait: clock.wait });
  clock.run();
  stop();
  clock.run(5);
  assert.equal(abandoned, 0);
});

test('a browser that refuses a window is only asked once', () => {
  /*
   * The refusal belongs to the frame, not to the press. Asking again on every
   * press costs the reader a second pop-up warning and buys nothing, while the
   * thing that does work - an ordinary link they press themselves - is what
   * the console offers instead once it knows.
   */
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  assert.equal(popupsBlocked(storage), false);
  savePopupsBlocked(true, storage);
  assert.equal(popupsBlocked(storage), true);
  // A browser that starts allowing them again is believed just as readily.
  savePopupsBlocked(false, storage);
  assert.equal(popupsBlocked(storage), false);

  // A private window, or a frame with site data blocked, throws on both. The
  // console then tries a window again, which is where it started.
  const blocked = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.equal(popupsBlocked(blocked), false);
  assert.doesNotThrow(() => savePopupsBlocked(true, blocked));
});
