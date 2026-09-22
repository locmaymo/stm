import test from 'node:test';
import assert from 'node:assert/strict';
import { POLL_LIVE_MS, POLL_LOG_MS, POLL_SETTLED_MS, inMotion, statusIntervalMs } from '../src/polling.js';

test('a console with nothing happening asks rarely', () => {
  const settled = {
    process: { status: 'running' },
    tunnel: { status: 'running', proxyPending: false },
    managerTunnel: { status: 'stopped' },
    working: false,
  };
  assert.equal(inMotion(settled), false);
  assert.equal(statusIntervalMs(settled), POLL_SETTLED_MS);
  // The state the console holds before anything has been read.
  assert.equal(statusIntervalMs({}), POLL_SETTLED_MS);
});

test('anything on its way keeps the fast clock', () => {
  // Somebody pressed Start and is watching for SillyTavern to come up.
  assert.equal(statusIntervalMs({ process: { status: 'starting' } }), POLL_LIVE_MS);
  assert.equal(statusIntervalMs({ process: { status: 'stopping' } }), POLL_LIVE_MS);
  // cloudflared has not announced an address yet.
  assert.equal(statusIntervalMs({ tunnel: { status: 'starting' } }), POLL_LIVE_MS);
  // The tunnel is up, but the fixed address in front of it is still deploying,
  // and that is the address the reader was told to keep.
  assert.equal(statusIntervalMs({ managerTunnel: { status: 'running', proxyPending: true } }), POLL_LIVE_MS);
  // An install, which this answer says nothing about.
  assert.equal(statusIntervalMs({ process: { status: 'stopped' }, working: true }), POLL_LIVE_MS);
});

test('a failure is a resting state, not something to watch', () => {
  // It stays broken until somebody does something about it, and asking four
  // times a minute does not make it better any sooner.
  assert.equal(statusIntervalMs({ process: { status: 'error' }, tunnel: { status: 'error' } }), POLL_SETTLED_MS);
});

test('a log being read has a clock between the other two', () => {
  // Fast enough to follow a log that is still running, slower than a start
  // somebody is watching for - and the log has no request of its own to do
  // it with any more.
  assert.equal(statusIntervalMs({ readingLog: true }), POLL_LOG_MS);
  assert.ok(POLL_LOG_MS > POLL_LIVE_MS);
  assert.ok(POLL_LOG_MS < POLL_SETTLED_MS);
  // Something actually moving still wins: the log is not what is being waited on.
  assert.equal(statusIntervalMs({ readingLog: true, working: true }), POLL_LIVE_MS);
  // Closing it goes back to the settled clock.
  assert.equal(statusIntervalMs({ readingLog: false }), POLL_SETTLED_MS);
});

test('the settled clock stays inside the gap the manager counts attention by', () => {
  // ActivityMeter.seen() stops counting a gap longer than CONSOLE_GAP_MS as
  // somebody being in front of the console. A settled clock slower than that
  // would leave the hours-used figure silently stuck at zero.
  const CONSOLE_GAP_MS = 30_000;
  assert.ok(POLL_SETTLED_MS < CONSOLE_GAP_MS);
});
