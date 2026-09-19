import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HANDLE, handleOffset, readHandle, saveHandle, snapHandle } from '../src/embed-handle.js';

function memory(): Storage {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
}

test('a handle let go settles against the nearer edge, clear of the very top and bottom', () => {
  assert.deepEqual(snapHandle(100, 400, 1000, 800), { side: 'left', top: 0.5 });
  assert.deepEqual(snapHandle(900, 400, 1000, 800), { side: 'right', top: 0.5 });
  assert.equal(snapHandle(900, 0, 1000, 800).top, 0.08);
  assert.equal(snapHandle(900, 800, 1000, 800).top, 0.92);
});

test('where the handle was left is remembered, and anything unreadable is the default', () => {
  const storage = memory();
  assert.deepEqual(readHandle(storage), DEFAULT_HANDLE);
  saveHandle({ side: 'left', top: 0.3 }, storage);
  assert.deepEqual(readHandle(storage), { side: 'left', top: 0.3 });
  storage.setItem('stm-embed-handle', '{"side":"up","top":2}');
  assert.deepEqual(readHandle(storage), DEFAULT_HANDLE);
  assert.deepEqual(readHandle(undefined), DEFAULT_HANDLE);
});

test('both edges are reached through the same property, so a handle slides to either', () => {
  // The bug this is about: a handle thrown right had its `left` replaced by a
  // `right`, and CSS cannot ease from one to the other - so it arrived without
  // moving, while one thrown left slid there.
  assert.deepEqual(handleOffset({ side: 'left', top: 0.5 }, 1000, 800, 48), { left: 10, top: 376 });
  assert.deepEqual(handleOffset({ side: 'right', top: 0.5 }, 1000, 800, 48), { left: 942, top: 376 });
  // A window narrower than the handle still puts it on screen.
  assert.deepEqual(handleOffset({ side: 'right', top: 0.5 }, 40, 800, 48), { left: 10, top: 376 });
  // And a stored height outside the margins is brought back inside them.
  assert.equal(handleOffset({ side: 'right', top: 3 }, 1000, 800, 48).top, 0.92 * 800 - 24);
});
