import test from 'node:test';
import assert from 'node:assert/strict';
import { readChecklistFolded, saveChecklistFolded } from '../src/setup-checklist.js';

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

test('the checklist remembers being folded or opened, unfinished or not', () => {
  const storage = memory();
  assert.equal(readChecklistFolded(storage), null);
  saveChecklistFolded(true, storage);
  assert.equal(readChecklistFolded(storage), true);
  saveChecklistFolded(false, storage);
  assert.equal(readChecklistFolded(storage), false);
});

test('storage that refuses is a fold for this visit only', () => {
  const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readChecklistFolded(refusing), null);
  assert.doesNotThrow(() => saveChecklistFolded(true, refusing));
});
