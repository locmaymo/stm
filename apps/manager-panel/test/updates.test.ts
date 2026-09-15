import test from 'node:test';
import assert from 'node:assert/strict';
import type { Installation, VersionOption } from '../../../packages/contracts/src/index.js';
import { availableUpdate, readDismissedUpdate, saveDismissedUpdate } from '../src/updates.js';

function option(selector: string, ref: string, channel: 'release' | 'staging' = 'release', tag: string | null = null): VersionOption {
  return { selector, label: ref, ref, channel, tag, publishedAt: null };
}

function installed(selector: string, resolvedRef: string, status: Installation['status'] = 'ready'): Installation {
  return { id: 'one', selector, resolvedRef, status, step: '', progress: 100, error: null, runtimePath: '', createdAt: '' } as Installation;
}

const catalogue = [option('latest', 'v1.13.5', 'release', '1.13.5'), option('release', 'v1.13.5'), option('staging', 'staging', 'staging')];

test('a newer release is offered once, by the ref it is', () => {
  assert.deepEqual(availableUpdate(catalogue, installed('1.13.2', 'v1.13.2')), { ref: 'v1.13.5', label: '1.13.5' });
});

test('nothing is offered when the installed copy is already the newest release', () => {
  assert.equal(availableUpdate(catalogue, installed('latest', 'v1.13.5')), null);
});

test('staging is never told it is behind, because being behind is what staging is', () => {
  assert.equal(availableUpdate(catalogue, installed('staging', 'abc1234')), null);
});

test('an install that is not finished is not offered a different version', () => {
  assert.equal(availableUpdate(catalogue, installed('1.13.2', 'v1.13.2', 'downloading')), null);
  assert.equal(availableUpdate(catalogue, installed('1.13.2', 'v1.13.2', 'failed')), null);
  assert.equal(availableUpdate(catalogue, null), null);
});

test('an empty or pointerless catalogue offers nothing rather than guessing', () => {
  assert.equal(availableUpdate([], installed('1.13.2', 'v1.13.2')), null);
  assert.deepEqual(
    availableUpdate([option('1.13.9', 'v1.13.9')], installed('1.13.2', 'v1.13.2')),
    { ref: 'v1.13.9', label: 'v1.13.9' },
  );
});

test('a dismissal remembers the version it was about, and survives storage being absent', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.equal(readDismissedUpdate(storage), null);
  saveDismissedUpdate('v1.13.5', storage);
  assert.equal(readDismissedUpdate(storage), 'v1.13.5');
  assert.equal(readDismissedUpdate(undefined), null);
  saveDismissedUpdate('v1.13.6', undefined);
});
