import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobLedger } from '../src/ledger.js';
import {
  CHUNK_BYTES,
  blobKey,
  decodeBlob,
  decodeSnapshot,
  encodeBlob,
  encodeSnapshot,
  hashFile,
  looksUnchanged,
  referencedHashes,
  shouldCompress,
  snapshotKey,
  SyncError,
  type R2Snapshot,
} from '../src/sync.js';

async function createDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'stm-r2-sync-'));
}

test('appending to a file leaves every chunk before the last one alone', async () => {
  const root = await createDirectory();
  const path = join(root, 'chat.jsonl');
  // A chat well past one chunk, so there is a settled chunk to compare.
  const body = Buffer.alloc(CHUNK_BYTES + 1024, 'a');
  await writeFile(path, body);
  const before = await hashFile('chats/chat.jsonl', path);
  assert.ok(before);
  assert.equal(before.chunks.length, 2);
  assert.equal(before.sizeBytes, body.byteLength);

  // This is the case the whole design is built around: one more message on the
  // end must not mean uploading the chat again.
  await writeFile(path, Buffer.concat([body, Buffer.from('one more line\n')]));
  const after = await hashFile('chats/chat.jsonl', path);
  assert.ok(after);
  assert.equal(after.chunks[0]?.hash, before.chunks[0]?.hash);
  assert.notEqual(after.chunks[1]?.hash, before.chunks[1]?.hash);
  assert.equal(after.chunks.length, 2);
});

test('identical content anywhere is one stored chunk', async () => {
  const root = await createDirectory();
  await writeFile(join(root, 'left.png'), 'the same bytes');
  await writeFile(join(root, 'right.png'), 'the same bytes');
  const left = await hashFile('a/left.png', join(root, 'left.png'));
  const right = await hashFile('b/right.png', join(root, 'right.png'));
  assert.equal(left?.chunks[0]?.hash, right?.chunks[0]?.hash);
});

test('a file that disappeared mid-backup is skipped, not fatal', async () => {
  const root = await createDirectory();
  assert.equal(await hashFile('gone.json', join(root, 'gone.json')), null);
});

test('an empty file survives the round trip as an empty file', async () => {
  const root = await createDirectory();
  const path = join(root, 'empty.json');
  await writeFile(path, '');
  const hashed = await hashFile('empty.json', path);
  assert.deepEqual(hashed?.chunks, []);
  assert.equal(hashed?.sizeBytes, 0);
});

test('a stored chunk says how to read itself, and never grows the data', async () => {
  const text = Buffer.from('{"mes":"hello"}\n'.repeat(500), 'utf8');
  const packed = await encodeBlob(text, true);
  assert.ok(packed.byteLength < text.byteLength);
  assert.deepEqual(await decodeBlob(packed), text);

  // Deflate on already dense bytes makes them bigger, and a backup that stores
  // more than it was given is the one result this must never produce.
  const dense = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 2654435761) % 256));
  const stored = await encodeBlob(dense, true);
  assert.ok(stored.byteLength <= dense.byteLength + 1);
  assert.deepEqual(await decodeBlob(stored), dense);

  assert.deepEqual(await decodeBlob(await encodeBlob(dense, false)), dense);
  await assert.rejects(() => decodeBlob(Buffer.from([0x7f, 0x00])), SyncError);
});

test('already compressed formats are not deflated a second time', () => {
  assert.equal(shouldCompress('chats/Assistant/2026-09-14.jsonl'), true);
  assert.equal(shouldCompress('settings.json'), true);
  assert.equal(shouldCompress('characters/Assistant.png'), false);
  assert.equal(shouldCompress('user/images/clip.mp4'), false);
  assert.equal(shouldCompress('cookie-secret'), true);
});

test('a snapshot survives the round trip and a damaged one is refused', async () => {
  const snapshot: R2Snapshot = {
    schemaVersion: 1,
    id: '2026-09-14T05-00-00-000Z',
    createdAt: '2026-09-14T05:00:00.000Z',
    profileId: 'profile-1',
    profileName: 'Default',
    layout: 'data',
    fingerprint: 'abc',
    files: [{ name: 'settings.json', sizeBytes: 12, mtimeMs: 1_700_000_000_000, chunks: [{ hash: 'a'.repeat(64), offset: 0, length: 12 }] }],
  };
  const encoded = await encodeSnapshot(snapshot);
  assert.deepEqual(await decodeSnapshot(encoded), snapshot);
  await assert.rejects(() => decodeSnapshot(Buffer.from('not gzip')), SyncError);
});

test('keys are stable, and a hash that is not a hash is refused', () => {
  const hash = 'b'.repeat(64);
  assert.equal(blobKey('sillytavern-manager/', hash), `sillytavern-manager/blobs/bb/${hash}`);
  assert.equal(snapshotKey('sillytavern-manager/', 'profile-1', '2026-09-14T05-00-00-000Z'), 'sillytavern-manager/snapshots/profile-1/2026-09-14T05-00-00-000Z.json.gz');
  assert.throws(() => blobKey('sillytavern-manager/', '../escape'), SyncError);
});

test('only a file whose size and time both match is left unread', () => {
  const previous = { name: 'settings.json', sizeBytes: 10, mtimeMs: 1000, chunks: [] };
  assert.equal(looksUnchanged(previous, 10, 1000), true);
  assert.equal(looksUnchanged(previous, 10, 1000.9), true);
  assert.equal(looksUnchanged(previous, 11, 1000), false);
  assert.equal(looksUnchanged(previous, 10, 1001), false);
  assert.equal(looksUnchanged(undefined, 10, 1000), false);
});

test('chunks shared by any surviving snapshot are not collectable', () => {
  const kept: R2Snapshot = { schemaVersion: 1, id: 'a', createdAt: 'a', profileId: 'p', profileName: 'p', layout: 'data', fingerprint: '', files: [{ name: 'one', sizeBytes: 1, mtimeMs: 0, chunks: [{ hash: 'a'.repeat(64), offset: 0, length: 1 }] }] };
  const dropped: R2Snapshot = { ...kept, id: 'b', files: [{ name: 'two', sizeBytes: 1, mtimeMs: 0, chunks: [{ hash: 'b'.repeat(64), offset: 0, length: 1 }] }] };
  const live = referencedHashes([kept]);
  assert.equal(live.has('a'.repeat(64)), true);
  assert.equal(live.has('b'.repeat(64)), false);
  assert.equal(referencedHashes([kept, dropped]).size, 2);
});

test('the ledger remembers across restarts and recovers from a torn write', async () => {
  const root = await createDirectory();
  const path = join(root, 'blobs', 'r2-blobs.log');
  const first = new BlobLedger({ path });
  await first.load();
  assert.equal(first.has('a'.repeat(64)), false);
  await first.add(['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)]);
  assert.equal(first.size, 2);

  const second = new BlobLedger({ path });
  await second.load();
  assert.equal(second.has('a'.repeat(64)), true);
  assert.equal(second.has('c'.repeat(64)), false);

  // A process killed mid-append leaves a half-written last line. Losing it
  // costs one redundant upload; refusing to load would cost every chunk.
  await writeFile(path, `${'a'.repeat(64)}\n${'b'.repeat(30)}`);
  const third = new BlobLedger({ path });
  await third.load();
  assert.equal(third.size, 1);
  assert.equal(third.has('a'.repeat(64)), true);
});

test('a listing of the bucket replaces what the ledger believed', async () => {
  const root = await createDirectory();
  const path = join(root, 'r2-blobs.log');
  const ledger = new BlobLedger({ path });
  await ledger.add(['a'.repeat(64), 'b'.repeat(64)]);

  // The bucket is the record of truth. Anything it no longer holds has to be
  // uploaded again, or a snapshot would point at a chunk that is not there.
  await ledger.reconcile(['b'.repeat(64), 'c'.repeat(64), 'not-a-hash']);
  assert.equal(ledger.has('a'.repeat(64)), false);
  assert.equal(ledger.has('c'.repeat(64)), true);
  assert.equal(ledger.size, 2);
  assert.deepEqual((await readFile(path, 'utf8')).trim().split('\n').sort(), ['b'.repeat(64), 'c'.repeat(64)]);

  await ledger.forget(['b'.repeat(64)]);
  assert.equal(ledger.size, 1);
});
