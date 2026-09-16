import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HANDLE, readHandle, saveHandle, snapHandle } from '../src/embed-handle.js';

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
