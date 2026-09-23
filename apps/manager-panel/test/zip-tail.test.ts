import test from 'node:test';
import assert from 'node:assert/strict';
import { centralDirectoryOffset } from '../src/zip-tail.js';

/** An end record pointing at `offset`, after `before` bytes and followed by a comment. */
function tail(offset: number, before: number, comment = ''): Uint8Array {
  const bytes = new Uint8Array(before + 22 + comment.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(before, 0x06054b50, true);
  view.setUint16(before + 10, 3, true);
  view.setUint32(before + 16, offset, true);
  view.setUint16(before + 20, comment.length, true);
  bytes.set(new TextEncoder().encode(comment), before + 22);
  return bytes;
}

test('the directory is found through a comment after the end record', () => {
  assert.equal(centralDirectoryOffset(tail(1234, 50, 'made by somebody'), 10_000), 1234);
});

test('a file that is not a zip, or a ZIP64 one, gives no directory', () => {
  assert.equal(centralDirectoryOffset(new Uint8Array(100), 100), null);
  assert.equal(centralDirectoryOffset(tail(0xffffffff, 10), 10_000), null);
  // A directory said to start past the end of the file is not this file's.
  assert.equal(centralDirectoryOffset(tail(20_000, 10), 10_000), null);
});
