import test from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_ONLINE_DEFAULT_MINUTES, KEEP_ONLINE_MAX_MINUTES, KEEP_ONLINE_MIN_MINUTES } from '../../../packages/contracts/src/index.js';
import { OnlineKeeper, intervalMinutes, reasonFor } from '../src/online.js';

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

test('the machine own address is the one reached, and it is reached whole', async () => {
  const reach = fakeReach();
  const keeper = new OnlineKeeper({ origin: 'https://console.example.invalid', enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.deepEqual(reach.urls, ['https://console.example.invalid/api/v1/health']);
  const state = keeper.state();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'holding');
  assert.equal(state.address, 'https://console.example.invalid');
  assert.equal(state.minutes, KEEP_ONLINE_DEFAULT_MINUTES);
  assert.equal(state.error, null);
  assert.ok(state.lastAt);
});

test('a manager with no address of its own does nothing at all', async () => {
  const reach = fakeReach();
  const keeper = new OnlineKeeper({ origin: null, enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(reach.urls.length, 0);
  assert.equal(keeper.state().status, 'no_address');
  assert.equal(keeper.state().address, null);
});

test('switched off, nothing is reached and nothing is claimed', async () => {
  const reach = fakeReach();
  const keeper = new OnlineKeeper({ origin: 'https://console.example.invalid', enabled: false, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(reach.urls.length, 0);
  assert.equal(keeper.state().status, 'off');
  assert.equal(keeper.state().address, null);
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
  const keeper = new OnlineKeeper({ origin: 'https://console.example.invalid', enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(reach.urls.length, 1);
  assert.equal(keeper.state().status, 'unreachable');
});

test('an address that stops answering is reported, once, and then recovered from', async () => {
  const lines: string[] = [];
  let answer: () => Response | Error = () => new Response('{}', { status: 200 });
  const reach = fakeReach(() => answer());
  const keeper = new OnlineKeeper({
    origin: 'https://console.example.invalid',
    enabled: true,
    fetch: reach.fetch,
    logger: (line) => { lines.push(typeof line === 'string' ? line : line.code); },
  });
  await keeper.tick();
  assert.equal(keeper.state().status, 'holding');

  answer = () => new Response('gone', { status: 502 });
  await keeper.tick();
  await keeper.tick();
  assert.equal(keeper.state().status, 'unreachable');
  assert.match(keeper.state().error ?? '', /502/u);
  assert.deepEqual(lines, ['online.unreachable'], 'a standing failure is said once');

  answer = () => new Response('{}', { status: 200 });
  await keeper.tick();
  assert.equal(keeper.state().status, 'holding');
  assert.equal(keeper.state().error, null);
  assert.deepEqual(lines, ['online.unreachable', 'online.reachable']);
});

test('a refused connection is a failure like any other, and does not escape', async () => {
  const reach = fakeReach(() => new Error('connect ECONNREFUSED'));
  const keeper = new OnlineKeeper({ origin: 'https://console.example.invalid', enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(keeper.state().status, 'unreachable');
  assert.match(keeper.state().error ?? '', /ECONNREFUSED/u);
});

test('the reason given is the one underneath, not the one Node prints over it', async () => {
  // Node reports every network failure as `fetch failed` and puts the reason
  // somebody could act on in the cause.
  const reach = fakeReach(() => new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9931') }));
  const keeper = new OnlineKeeper({ origin: 'https://console.example.invalid', enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(keeper.state().error, 'connect ECONNREFUSED 127.0.0.1:9931');
  assert.equal(reasonFor('not an error at all'), 'unknown error');
  assert.equal(reasonFor(new Error('plain')), 'plain');
});

test('switching off forgets what the last attempt found', async () => {
  const reach = fakeReach(() => new Error('connect ECONNREFUSED'));
  const keeper = new OnlineKeeper({ origin: 'https://console.example.invalid', enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(keeper.state().status, 'unreachable');
  keeper.setEnabled(false);
  const state = keeper.state();
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
  const keeper = new OnlineKeeper({ origin: 'https://console.example.invalid', enabled: true, minutes: 60, fetch: reach.fetch });
  assert.equal(keeper.state().minutes, 60);
  keeper.start();
  // Somebody has just found out their machine goes quiet sooner than they
  // thought. Making them wait out the hour to learn whether five minutes
  // works is the wrong answer.
  keeper.setEnabled(true, 5);
  assert.equal(keeper.state().minutes, 5);
  // Switching off and on again does not lose what they chose.
  keeper.setEnabled(false);
  keeper.setEnabled(true);
  assert.equal(keeper.state().minutes, 5);
  keeper.close();
});
