import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeCommand } from '../../../packages/contracts/src/index.js';
import { BRIDGE_EXPIRY_MS, BRIDGE_SCRIPT, BridgeBusyError, parseBridgeResult, SillyTavernBridge, type BridgeDelivery } from '../src/st-bridge.js';

const profile = { kind: 'slash', command: '/profile Work' } as const;

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test('only one allowlisted slash command, with nothing chained on, is a command', () => {
  assert.deepEqual(parseBridgeCommand({ kind: 'slash', command: '  /profile My Profile  ' }), { kind: 'slash', command: '/profile My Profile' });
  assert.deepEqual(parseBridgeCommand({ kind: 'slash', command: '/secret-id quiet=true abc' }), { kind: 'slash', command: '/secret-id quiet=true abc' });
  assert.deepEqual(parseBridgeCommand({ kind: 'slash', command: '/THEME Cappuccino' }), { kind: 'slash', command: '/THEME Cappuccino' });
  for (const command of [
    '/profile Work | /echo hi',
    '/profile Work\n/run evil',
    '/profile {{user}}',
    '/profile {: /run x :}',
    '/run something',
    '/profiles',
    '/echo /profile',
    'profile Work',
    `/profile ${'x'.repeat(600)}`,
  ]) assert.equal(parseBridgeCommand({ kind: 'slash', command }), null, command);
  assert.equal(parseBridgeCommand({ kind: 'slash' }), null);
  assert.equal(parseBridgeCommand({ kind: 'eval', code: 'alert(1)' }), null);
  assert.equal(parseBridgeCommand(null), null);
});

test('a refresh names a list the page knows how to reload', () => {
  assert.deepEqual(parseBridgeCommand({ kind: 'refresh', what: 'characters' }), { kind: 'refresh', what: 'characters' });
  assert.deepEqual(parseBridgeCommand({ kind: 'refresh', what: 'worlds' }), { kind: 'refresh', what: 'worlds' });
  assert.equal(parseBridgeCommand({ kind: 'refresh', what: 'everything' }), null);
});

test('the page checks the same list again before running anything', () => {
  assert.match(BRIDGE_SCRIPT, /\["profile","api","model","secret-id","theme"\]/u);
  assert.match(BRIDGE_SCRIPT, /\["characters","worlds"\]/u);
  // The checks survive being put in a template string: real escapes, not doubled ones.
  assert.ok(BRIDGE_SCRIPT.includes('/[|\\r\\n]|\\{\\{|\\{:|:\\}/'), 'the chaining check');
  assert.ok(!BRIDGE_SCRIPT.includes('eval('), 'nothing is evaluated');
});

test('a command goes at once to an open tab, and its answer comes back', async () => {
  const bridge = new SillyTavernBridge();
  const got: BridgeDelivery[] = [];
  bridge.connect('tabaaaaaaaa1', { visible: true, stVersion: '1.19.0' }, (delivery) => got.push(delivery));
  const sent = bridge.send(profile);
  assert.equal(sent.state, 'delivered');
  assert.equal(sent.tabs, 1);
  assert.deepEqual(got, [{ id: sent.id, command: profile }]);
  const waiting = bridge.wait(sent.id, 5_000);
  assert.equal(bridge.result('tabaaaaaaaa1', sent.id, { ok: true, value: 'Work' }), true);
  assert.deepEqual(await waiting, { id: sent.id, state: 'done', result: { ok: true, value: 'Work' }, tabs: 1 });
  bridge.close();
});

test('with no tab open a command waits, and goes to the first tab that connects', () => {
  const bridge = new SillyTavernBridge();
  const sent = bridge.send(profile);
  assert.equal(sent.state, 'waiting');
  assert.equal(sent.tabs, 0);
  const got: BridgeDelivery[] = [];
  bridge.connect('tabaaaaaaaa1', { visible: false, stVersion: '' }, (delivery) => got.push(delivery));
  assert.deepEqual(got.map((delivery) => delivery.id), [sent.id]);
  assert.equal(bridge.status(sent.id)?.state, 'delivered');
  bridge.close();
});

test('the tab looked at last is the one asked', () => {
  const time = clock();
  const bridge = new SillyTavernBridge({ now: time.now });
  const first: BridgeDelivery[] = [];
  const second: BridgeDelivery[] = [];
  bridge.connect('tabaaaaaaaa1', { visible: true, stVersion: '' }, (delivery) => first.push(delivery));
  time.advance(1_000);
  bridge.connect('tabaaaaaaaa2', { visible: false, stVersion: '' }, (delivery) => second.push(delivery));
  bridge.send(profile);
  assert.equal(first.length, 1, 'the hidden tab connected later, but the other was looked at');
  time.advance(1_000);
  bridge.report('tabaaaaaaaa2', { visible: true, stVersion: '' });
  bridge.send(profile);
  assert.equal(second.length, 1);
  assert.equal(first.length, 1);
  bridge.close();
});

test('only the tab that was given a command can answer it', () => {
  const bridge = new SillyTavernBridge();
  bridge.connect('tabaaaaaaaa1', { visible: true, stVersion: '' }, () => undefined);
  const sent = bridge.send(profile);
  assert.equal(bridge.result('tabaaaaaaaa2', sent.id, { ok: true, value: 'x' }), false);
  assert.equal(bridge.result('tabaaaaaaaa1', 'no-such-id', { ok: true, value: 'x' }), false);
  assert.equal(bridge.status(sent.id)?.state, 'delivered');
  bridge.close();
});

test('a tab without a stream collects its commands when it reports', () => {
  const bridge = new SillyTavernBridge();
  bridge.report('tabaaaaaaaa1', { visible: true, stVersion: '1.19.0' });
  const sent = bridge.send(profile);
  assert.equal(sent.state, 'waiting', 'nothing to push it on');
  assert.deepEqual(bridge.report('tabaaaaaaaa1', { visible: true, stVersion: '1.19.0' }), [{ id: sent.id, command: profile }]);
  assert.equal(bridge.status(sent.id)?.state, 'delivered');
  // Asked again before it answered, it is given the same command again.
  assert.deepEqual(bridge.report('tabaaaaaaaa1', { visible: true, stVersion: '1.19.0' }).map((delivery) => delivery.id), [sent.id]);
  bridge.close();
});

test('a tab that reconnects is sent again what it had not answered', () => {
  const bridge = new SillyTavernBridge();
  const first: BridgeDelivery[] = [];
  const disconnect = bridge.connect('tabaaaaaaaa1', { visible: true, stVersion: '' }, (delivery) => first.push(delivery));
  const sent = bridge.send(profile);
  disconnect();
  const again: BridgeDelivery[] = [];
  bridge.connect('tabaaaaaaaa1', { visible: true, stVersion: '' }, (delivery) => again.push(delivery));
  assert.deepEqual(again.map((delivery) => delivery.id), [sent.id]);
  bridge.close();
});

test('a tab that went away hands its unanswered commands to the next one', () => {
  const time = clock();
  const bridge = new SillyTavernBridge({ now: time.now });
  const disconnect = bridge.connect('tabaaaaaaaa1', { visible: true, stVersion: '' }, () => undefined);
  const sent = bridge.send(profile);
  disconnect();
  time.advance(31_000);
  assert.equal(bridge.status(sent.id)?.state, 'waiting');
  assert.equal(bridge.summary().tabs, 0);
  const got: BridgeDelivery[] = [];
  bridge.connect('tabaaaaaaaa2', { visible: true, stVersion: '' }, (delivery) => got.push(delivery));
  assert.deepEqual(got.map((delivery) => delivery.id), [sent.id]);
  bridge.close();
});

test('a command nobody takes expires after ten minutes, and is forgotten later', async () => {
  const time = clock();
  const bridge = new SillyTavernBridge({ now: time.now });
  const sent = bridge.send(profile);
  time.advance(BRIDGE_EXPIRY_MS - 1);
  assert.equal(bridge.status(sent.id)?.state, 'waiting');
  time.advance(1);
  assert.deepEqual(bridge.status(sent.id), { id: sent.id, state: 'expired', result: { ok: false, error: 'expired' }, tabs: 0 });
  assert.equal((await bridge.wait(sent.id, 5_000))?.state, 'expired', 'an expired command is answered at once');
  time.advance(10 * 60 * 1000);
  assert.equal(bridge.status(sent.id), null);
  bridge.close();
});

test('a wait ends at its timeout, or when the caller goes', async () => {
  const bridge = new SillyTavernBridge();
  const sent = bridge.send(profile);
  assert.equal((await bridge.wait(sent.id, 20))?.state, 'waiting');
  const gone = new AbortController();
  const waiting = bridge.wait(sent.id, 60_000, gone.signal);
  gone.abort();
  assert.equal((await waiting)?.state, 'waiting');
  assert.equal(await bridge.wait('no-such-id', 20), null);
  bridge.close();
});

test('a caller that queues without end is stopped', () => {
  const bridge = new SillyTavernBridge();
  for (let index = 0; index < 100; index += 1) bridge.send(profile);
  assert.throws(() => bridge.send(profile), BridgeBusyError);
  bridge.close();
});

test('a result is cut down to size, and anything else is not a result', () => {
  assert.deepEqual(parseBridgeResult({ tab: 'tabaaaaaaaa1', id: 'x', ok: true, value: 'v'.repeat(2000) }), { tab: 'tabaaaaaaaa1', id: 'x', result: { ok: true, value: 'v'.repeat(1000) } });
  assert.deepEqual(parseBridgeResult({ tab: 'tabaaaaaaaa1', id: 'x', ok: false }), { tab: 'tabaaaaaaaa1', id: 'x', result: { ok: false, error: 'failed' } });
  assert.equal(parseBridgeResult({ tab: 'short', id: 'x', ok: true }), null);
  assert.equal(parseBridgeResult({ tab: 'tabaaaaaaaa1', id: 'x' }), null);
  assert.equal(parseBridgeResult('nope'), null);
});
