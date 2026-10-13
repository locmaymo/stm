import test from 'node:test';
import assert from 'node:assert/strict';
import type { AvailableUpdate, VersionSwitch } from '../../../packages/contracts/src/index.js';
import { IDLE_MS, localDay, nightlyDecision, NightlyUpdater, type NightlyInput } from '../src/nightly-update.js';

/** Twenty past four in the morning, by this machine's clock, whatever its zone. */
const night = new Date(2026, 9, 14, 4, 20, 0);
const update: AvailableUpdate = { ref: '1.19.0', label: '1.19.0' };
const ready: NightlyInput = { now: night, enabled: true, update, lastUseAt: 0, lastTryDay: null, busy: false, lastSwitch: null };

test('a release is installed at four in the morning when nothing is using SillyTavern', () => {
  assert.equal(nightlyDecision(ready), 'go');
  assert.equal(nightlyDecision({ ...ready, lastUseAt: night.getTime() - IDLE_MS - 1 }), 'go', 'last used over an hour ago');
});

test('nothing happens unless it was asked for, at the hour, with something to install', () => {
  assert.equal(nightlyDecision({ ...ready, enabled: false }), 'disabled');
  assert.equal(nightlyDecision({ ...ready, now: new Date(2026, 9, 14, 3, 59, 0) }), 'notTime');
  assert.equal(nightlyDecision({ ...ready, now: new Date(2026, 9, 14, 5, 0, 0) }), 'notTime');
  assert.equal(nightlyDecision({ ...ready, update: null }), 'noUpdate');
});

test('somebody using SillyTavern in the last hour is not interrupted, and neither is a running task', () => {
  assert.equal(nightlyDecision({ ...ready, lastUseAt: night.getTime() - 5 * 60 * 1000 }), 'inUse');
  assert.equal(nightlyDecision({ ...ready, busy: true }), 'busy');
});

test('one try a night, and never again for a release that was already taken back', () => {
  assert.equal(nightlyDecision({ ...ready, lastTryDay: localDay(night) }), 'triedToday');
  assert.equal(nightlyDecision({ ...ready, lastTryDay: localDay(new Date(2026, 9, 13, 4, 20, 0)) }), 'go', 'yesterday’s try does not count');
  const failed: VersionSwitch = { previousInstallationId: 'a', previousRef: '1.18.0', installationId: 'b', ref: '1.19.0', at: '2026-10-13T04:20:00.000Z', safetyCopyId: null, profileId: null, outcome: 'rolledBack', reason: 'exited', dismissed: true };
  assert.equal(nightlyDecision({ ...ready, lastSwitch: failed }), 'failedBefore');
  assert.equal(nightlyDecision({ ...ready, lastSwitch: { ...failed, outcome: 'kept' } }), 'go');
  assert.equal(nightlyDecision({ ...ready, lastSwitch: { ...failed, ref: '1.18.5' } }), 'go', 'a different release is tried');
});

test('the clock starts the install once in the night, and asks nothing while it is off', async () => {
  let now = night;
  let enabled = true;
  let asked = 0;
  const installed: string[] = [];
  const updater = new NightlyUpdater({
    enabled: async () => enabled,
    update: async () => { asked += 1; return update; },
    lastUseAt: () => 0,
    busy: () => false,
    lastSwitch: async () => null,
    install: async (next) => { installed.push(next.ref); },
    now: () => now,
  });
  assert.equal(await updater.tick(), 'go');
  assert.equal(await updater.tick(), 'triedToday');
  assert.deepEqual(installed, ['1.19.0']);
  now = new Date(2026, 9, 15, 4, 5, 0);
  enabled = false;
  const before = asked;
  assert.equal(await updater.tick(), 'disabled');
  assert.equal(asked, before, 'turned off, nothing is fetched to decide');
  enabled = true;
  now = new Date(2026, 9, 15, 13, 0, 0);
  assert.equal(await updater.tick(), 'notTime');
  assert.equal(asked, before, 'and outside the hour neither');
});
