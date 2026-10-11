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

test('a file that is not a zip, or a ZIP64 one without its record, gives no directory', () => {
  assert.equal(centralDirectoryOffset(new Uint8Array(100), 100), null);
  assert.equal(centralDirectoryOffset(tail(0xffffffff, 10), 10_000), null);
  // A directory said to start past the end of the file is not this file's.
  assert.equal(centralDirectoryOffset(tail(20_000, 10), 10_000), null);
});

/** A ZIP64 end: the record saying the directory is at `offset`, its locator, and an end record of sentinels. */
function zip64Tail(offset: number, fileSize: number, before: number): Uint8Array {
  const bytes = new Uint8Array(before + 56 + 20 + 22);
  const view = new DataView(bytes.buffer);
  const recordAt = fileSize - bytes.length + before;
  view.setUint32(before, 0x06064b50, true);
  view.setBigUint64(before + 48, BigInt(offset), true);
  view.setUint32(before + 56, 0x07064b50, true);
  view.setBigUint64(before + 56 + 8, BigInt(recordAt), true);
  view.setUint32(before + 76, 0x06054b50, true);
  view.setUint16(before + 76 + 10, 0xffff, true);
  view.setUint32(before + 76 + 16, 0xffffffff, true);
  return bytes;
}

test('a ZIP64 archive past four gigabytes gives the directory its record holds', () => {
  const size = 10 * 1024 ** 3;
  assert.equal(centralDirectoryOffset(zip64Tail(size - 5000, size, 40), size), size - 5000);
  // A locator pointing anywhere but at a record is not one to follow.
  const broken = zip64Tail(size - 5000, size, 40);
  new DataView(broken.buffer).setUint32(40, 0, true);
  assert.equal(centralDirectoryOffset(broken, size), null);
});
