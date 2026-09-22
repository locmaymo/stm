import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineKeeper, reasonFor } from '../src/online.js';

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

test('the address this manager is handed out at is the one kept open', async () => {
  const reach = fakeReach();
  const keeper = new OnlineKeeper({
    addresses: () => ['https://console.example.invalid', 'https://slower.example.invalid'],
    enabled: true,
    fetch: reach.fetch,
  });
  await keeper.tick();
  assert.deepEqual(reach.urls, ['https://console.example.invalid/api/v1/health']);
  const state = keeper.state();
  assert.equal(state.enabled, true);
  assert.equal(state.status, 'holding');
  assert.equal(state.address, 'https://console.example.invalid');
  assert.equal(state.error, null);
  assert.ok(state.lastAt);
});

test('a manager reachable only from its own computer does nothing at all', async () => {
  const reach = fakeReach();
  const keeper = new OnlineKeeper({ addresses: () => [], enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(reach.urls.length, 0);
  assert.equal(keeper.state().status, 'no_address');
  assert.equal(keeper.state().address, null);
});

test('switched off, nothing is reached and nothing is claimed', async () => {
  const reach = fakeReach();
  const keeper = new OnlineKeeper({ addresses: () => ['https://console.example.invalid'], enabled: false, fetch: reach.fetch });
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
  const keeper = new OnlineKeeper({ addresses: () => ['https://tunnel.example.invalid'], enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(reach.urls.length, 1);
  assert.equal(keeper.state().status, 'unreachable');
});

test('an address that stops answering is reported, once, and then recovered from', async () => {
  const lines: string[] = [];
  let answer: () => Response | Error = () => new Response('{}', { status: 200 });
  const reach = fakeReach(() => answer());
  const keeper = new OnlineKeeper({
    addresses: () => ['https://console.example.invalid'],
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
  const keeper = new OnlineKeeper({ addresses: () => ['https://console.example.invalid'], enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(keeper.state().status, 'unreachable');
  assert.match(keeper.state().error ?? '', /ECONNREFUSED/u);
});

test('the reason given is the one underneath, not the one Node prints over it', async () => {
  // Node reports every network failure as `fetch failed` and puts the reason
  // somebody could act on in the cause.
  const reach = fakeReach(() => new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9931') }));
  const keeper = new OnlineKeeper({ addresses: () => ['https://console.example.invalid'], enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(keeper.state().error, 'connect ECONNREFUSED 127.0.0.1:9931');
  assert.equal(reasonFor('not an error at all'), 'unknown error');
  assert.equal(reasonFor(new Error('plain')), 'plain');
});

test('switching off forgets what the last attempt found', async () => {
  const reach = fakeReach(() => new Error('connect ECONNREFUSED'));
  const keeper = new OnlineKeeper({ addresses: () => ['https://console.example.invalid'], enabled: true, fetch: reach.fetch });
  await keeper.tick();
  assert.equal(keeper.state().status, 'unreachable');
  keeper.setEnabled(false);
  const state = keeper.state();
  assert.equal(state.status, 'off');
  assert.equal(state.error, null);
  assert.equal(state.lastAt, null, 'a failure of something no longer being tried is not news');
});

test('an address that appears later is picked up without a restart', async () => {
  const reach = fakeReach();
  let address: string | null = null;
  const keeper = new OnlineKeeper({
    addresses: () => address === null ? [] : [address],
    enabled: true,
    fetch: reach.fetch,
  });
  await keeper.tick();
  assert.equal(keeper.state().status, 'no_address');
  // A tunnel has come up, and the manager now has somewhere to be reached.
  address = 'https://busy-lake-1234.example.invalid';
  await keeper.tick();
  assert.deepEqual(reach.urls, ['https://busy-lake-1234.example.invalid/api/v1/health']);
  assert.equal(keeper.state().status, 'holding');
});
