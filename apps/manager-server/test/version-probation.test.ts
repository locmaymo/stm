import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessState, VersionSwitch } from '../../../packages/contracts/src/index.js';
import { VersionSwitchStore, watchProbation } from '../src/version-probation.js';

const running: ProcessState = { status: 'running', installationId: 'new', profileId: null, pid: 1, startedAt: null, error: null };

test('a version that comes up and stays up is healthy', async () => {
  const result = await watchProbation({ start: async () => running, state: () => running, servedSince: () => false, windowMs: 30, pollMs: 5 });
  assert.deepEqual(result, { outcome: 'healthy', served: false, reason: null });
});

test('a version that will not start has failed, and nothing reached it', async () => {
  const result = await watchProbation({ start: async () => ({ ...running, status: 'error', error: 'SillyTavern exited on its own (exit code 1)' }), state: () => running, servedSince: () => false, windowMs: 30, pollMs: 5 });
  assert.deepEqual(result, { outcome: 'failed', served: false, reason: 'SillyTavern exited on its own (exit code 1)' });
  const thrown = await watchProbation({ start: async () => { throw new Error('marker missing'); }, state: () => running, servedSince: () => false, windowMs: 30, pollMs: 5 });
  assert.equal(thrown.outcome, 'failed');
  assert.equal(thrown.reason, 'marker missing');
});

test('a version that falls over while being watched has failed, and says whether it was written to first', async () => {
  let state = running;
  setTimeout(() => { state = { ...running, status: 'error', error: 'crashed' }; }, 15);
  const result = await watchProbation({ start: async () => running, state: () => state, servedSince: () => true, windowMs: 1000, pollMs: 5 });
  assert.deepEqual(result, { outcome: 'failed', served: true, reason: 'crashed' });
});

test('a version somebody stopped is their decision, not its failure', async () => {
  let state = running;
  setTimeout(() => { state = { ...running, status: 'stopped' }; }, 15);
  const started = Date.now();
  const result = await watchProbation({ start: async () => running, state: () => state, servedSince: () => false, windowMs: 10_000, pollMs: 5 });
  assert.equal(result.outcome, 'healthy');
  assert.ok(Date.now() - started < 5_000, 'and the watch ends there');
});

test('the last switch is kept across a restart and updated in place', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'stm-version-switch-'));
  const record: VersionSwitch = { previousInstallationId: 'old', previousRef: '1.18.0', installationId: 'new', ref: '1.19.0', at: '2026-10-13T08:00:00.000Z', safetyCopyId: null, profileId: 'p', outcome: 'probation', reason: null, dismissed: false };
  const store = new VersionSwitchStore(stateDir);
  assert.equal(await store.get(), null);
  assert.equal(await store.update({ dismissed: true }), null, 'nothing to update before a switch');
  await store.set(record);
  await store.update({ outcome: 'kept' });
  assert.deepEqual(await new VersionSwitchStore(stateDir).get(), { ...record, outcome: 'kept' });
});
