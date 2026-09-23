import test from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_ONLINE_DEFAULT_MINUTES, KEEP_ONLINE_MAX_MINUTES, KEEP_ONLINE_MIN_MINUTES } from '../../../packages/contracts/src/index.js';
import { OnlineKeeper, type OnlineKeeperOptions, intervalMinutes, reasonFor } from '../src/online.js';

const LOCAL = 'http://127.0.0.1:7876';

/** Every address reached, and whatever the test wants each one answered with. */
function fakeReach(answer: () => Response | Error = () => new Response('{}', { status: 200 })): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    urls.push(String(input));
    const result = answer();
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, urls };
}

function keeper(options: Partial<OnlineKeeperOptions> & { fetch: typeof globalThis.fetch }): OnlineKeeper {
  return new OnlineKeeper({
    configuredOrigin: null,
    localOrigin: () => LOCAL,
    enabled: true,
    ...options,
  });
}

test('an address somebody wrote down outranks everything else', async () => {
  const reach = fakeReach();
  const watch = keeper({ configuredOrigin: 'https://written.example.invalid', seenOrigin: 'https://seen.example.invalid', fetch: reach.fetch });
  await watch.tick();
  assert.deepEqual(reach.urls, ['https://written.example.invalid/api/v1/health']);
  const state = watch.state();
  assert.equal(state.source, 'configured');
  assert.equal(state.status, 'holding');
  assert.equal(state.minutes, KEEP_ONLINE_DEFAULT_MINUTES);
  assert.ok(state.lastAt);
});

test('with nothing written down, the address a browser arrived at is the one held', async () => {
  const reach = fakeReach();
  const remembered: Array<string | null> = [];
  const watch = keeper({ fetch: reach.fetch, rememberOrigin: (origin) => remembered.push(origin) });

  // Nothing has opened this console yet, so it holds itself.
  await watch.tick();
  assert.deepEqual(reach.urls, [`${LOCAL}/api/v1/health`]);
  assert.equal(watch.state().source, 'local');
  assert.equal(watch.state().address, LOCAL);

  // Somebody opens it at the address the platform handed out. Nobody had to
  // write that down anywhere: it is in the request the console just made.
  watch.seen('https://some-app-cs6f.example.invalid');
  await watch.tick();
  assert.equal(reach.urls.at(-1), 'https://some-app-cs6f.example.invalid/api/v1/health');
  assert.equal(watch.state().source, 'seen');
  // Written down, so a restart while nobody is looking still knows where it is.
  assert.deepEqual(remembered, ['https://some-app-cs6f.example.invalid']);

  // The same address again teaches nothing and writes nothing.
  watch.seen('https://some-app-cs6f.example.invalid');
  assert.deepEqual(remembered, ['https://some-app-cs6f.example.invalid']);

  // A redeploy hands out a different one, and the newest a browser used wins.
  watch.seen('https://some-app-zzzz.example.invalid');
  await watch.tick();
  assert.equal(reach.urls.at(-1), 'https://some-app-zzzz.example.invalid/api/v1/health');
});

test('an address learned before a restart is used without waiting for a console', async () => {
  const reach = fakeReach();
  const watch = keeper({ seenOrigin: 'https://remembered.example.invalid', fetch: reach.fetch });
  await watch.tick();
  assert.deepEqual(reach.urls, ['https://remembered.example.invalid/api/v1/health']);
  assert.equal(watch.state().source, 'seen');
});

test('a learned address that stops answering is let go, and loopback is what is left', async () => {
  const lines: string[] = [];
  const remembered: Array<string | null> = [];
  const reach = fakeReach(() => new Error('connect ECONNREFUSED'));
  const watch = keeper({
    seenOrigin: 'https://gone.example.invalid',
    fetch: reach.fetch,
    rememberOrigin: (origin) => remembered.push(origin),
    logger: (line) => { lines.push(typeof line === 'string' ? line : line.code); },
  });
  await watch.tick();
  await watch.tick();
  assert.equal(watch.state().source, 'seen', 'two failures is not yet a verdict');
  await watch.tick();

  const state = watch.state();
  assert.equal(state.source, 'local');
  assert.equal(state.address, LOCAL);
  // And the file is told, so the next start does not send anything there either.
  assert.deepEqual(remembered, [null]);
  assert.deepEqual(lines, ['online.unreachable', 'online.forgotten']);
});

test('an address somebody wrote down is never let go, however long it fails', async () => {
  const reach = fakeReach(() => new Error('connect ECONNREFUSED'));
  const watch = keeper({ configuredOrigin: 'https://written.example.invalid', fetch: reach.fetch });
  for (let turn = 0; turn < 5; turn += 1) await watch.tick();
  // An instruction, not a guess: the reader is told it is failing and it keeps
  // trying, because they are the one who said where this manager is.
  assert.equal(watch.state().source, 'configured');
  assert.equal(watch.state().status, 'unreachable');
});

test('switched off, nothing is reached and nothing is claimed', async () => {
  const reach = fakeReach();
  const watch = keeper({ configuredOrigin: 'https://written.example.invalid', enabled: false, fetch: reach.fetch });
  await watch.tick();
  assert.equal(reach.urls.length, 0);
  assert.equal(watch.state().status, 'off');
  assert.equal(watch.state().address, null);
});

test('nothing is ever reported as held without having been reached', async () => {
  /*
   * A turn used to be skipped while somebody was reading the console, on the
   * reasoning that a reader is already reaching this manager through the same
   * address several times a minute. The reasoning is an inference, and the
   * inference is false whenever the reader arrived somewhere other than the
   * address being kept open - so a card reported an address as held that
   * nothing had touched. Every turn goes to the address now.
   */
  const reach = fakeReach(() => new Error('connect ECONNREFUSED'));
  const watch = keeper({ configuredOrigin: 'https://written.example.invalid', fetch: reach.fetch });
  await watch.tick();
  assert.equal(reach.urls.length, 1);
  assert.equal(watch.state().status, 'unreachable');
});

test('an address that stops answering is reported, once, and then recovered from', async () => {
  const lines: string[] = [];
  let answer: () => Response | Error = () => new Response('{}', { status: 200 });
  const reach = fakeReach(() => answer());
  const watch = keeper({
    configuredOrigin: 'https://written.example.invalid',
    fetch: reach.fetch,
    logger: (line) => { lines.push(typeof line === 'string' ? line : line.code); },
  });
  await watch.tick();
  assert.equal(watch.state().status, 'holding');

  answer = () => new Response('gone', { status: 502 });
  await watch.tick();
  await watch.tick();
  assert.equal(watch.state().status, 'unreachable');
  assert.match(watch.state().error ?? '', /502/u);
  assert.deepEqual(lines, ['online.unreachable'], 'a standing failure is said once');

  answer = () => new Response('{}', { status: 200 });
  await watch.tick();
  assert.equal(watch.state().status, 'holding');
  assert.equal(watch.state().error, null);
  assert.deepEqual(lines, ['online.unreachable', 'online.reachable']);
});

test('the reason given is the one underneath, not the one Node prints over it', async () => {
  // Node reports every network failure as `fetch failed` and puts the reason
  // somebody could act on in the cause.
  const reach = fakeReach(() => new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9931') }));
  const watch = keeper({ configuredOrigin: 'https://written.example.invalid', fetch: reach.fetch });
  await watch.tick();
  assert.equal(watch.state().error, 'connect ECONNREFUSED 127.0.0.1:9931');
  assert.equal(reasonFor('not an error at all'), 'unknown error');
  assert.equal(reasonFor(new Error('plain')), 'plain');
});

test('switching off forgets what the last attempt found', async () => {
  const reach = fakeReach(() => new Error('connect ECONNREFUSED'));
  const watch = keeper({ configuredOrigin: 'https://written.example.invalid', fetch: reach.fetch });
  await watch.tick();
  assert.equal(watch.state().status, 'unreachable');
  watch.setEnabled(false);
  const state = watch.state();
  assert.equal(state.status, 'off');
  assert.equal(state.error, null);
  assert.equal(state.lastAt, null, 'a failure of something no longer being tried is not news');
});

test('the interval is the reader’s, held inside what this will actually do', () => {
  assert.equal(intervalMinutes(undefined), KEEP_ONLINE_DEFAULT_MINUTES);
  assert.equal(intervalMinutes('30'), KEEP_ONLINE_DEFAULT_MINUTES, 'a file carrying nonsense is corrected');
  assert.equal(intervalMinutes(Number.NaN), KEEP_ONLINE_DEFAULT_MINUTES);
  assert.equal(intervalMinutes(30), 30);
  assert.equal(intervalMinutes(4.6), 5);
  assert.equal(intervalMinutes(0), KEEP_ONLINE_MIN_MINUTES);
  assert.equal(intervalMinutes(-90), KEEP_ONLINE_MIN_MINUTES);
  assert.equal(intervalMinutes(10_000), KEEP_ONLINE_MAX_MINUTES);
});

test('a changed interval takes effect rather than waiting out the one running', () => {
  const reach = fakeReach();
  const watch = keeper({ configuredOrigin: 'https://written.example.invalid', minutes: 60, fetch: reach.fetch });
  assert.equal(watch.state().minutes, 60);
  watch.start();
  // Somebody has just found out their machine goes quiet sooner than they
  // thought. Making them wait out the hour to learn whether five minutes
  // works is the wrong answer.
  watch.setEnabled(true, 5);
  assert.equal(watch.state().minutes, 5);
  // Switching off and on again does not lose what they chose.
  watch.setEnabled(false);
  watch.setEnabled(true);
  assert.equal(watch.state().minutes, 5);
  watch.close();
});
