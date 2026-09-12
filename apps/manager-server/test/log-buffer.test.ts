import test from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer, LOG_LIMITS } from '../src/log-buffer.js';

test('combined logs preserve ordering, filter sources, and advance the shared cursor', () => {
  const logs = new LogBuffer();
  logs.append('manager', 'Started');
  logs.append('installer', '[32mInstalling[0m');
  logs.append('sillytavern', 'Ready');
  assert.deepEqual(logs.read(0, null).entries.map((entry) => entry.source), ['manager', 'installer', 'sillytavern']);
  assert.equal(logs.read(0, 'installer').entries[0]?.message, 'Installing');
  assert.equal(logs.read(0, 'installer').nextCursor, 3);
  assert.deepEqual(logs.read(3, null).entries, []);
});

test('log buffer evicts by both row count and text size, and caps individual messages', () => {
  const logs = new LogBuffer();
  logs.append('manager', 'Oldest');
  for (let index = 0; index < LOG_LIMITS.entries; index++) logs.append('installer', 'line');
  assert.equal(logs.read(0, 'manager').entries.length, 0);
  assert.equal(logs.read(0, null).entries.length, LOG_LIMITS.responseEntries);

  const largeLogs = new LogBuffer();
  largeLogs.append('manager', 'Oldest');
  // Enough full-width messages to pass the character cap well before the row cap.
  const messages = Math.ceil(LOG_LIMITS.totalCharacters / LOG_LIMITS.messageCharacters) + 16;
  assert.ok(messages < LOG_LIMITS.entries);
  for (let index = 0; index < messages; index++) largeLogs.append('installer', '🙂'.repeat(LOG_LIMITS.messageCharacters));
  assert.equal(largeLogs.read(0, 'manager').entries.length, 0);
  const retained = largeLogs.read(0, null).entries;
  assert.ok(retained.every((entry) => entry.message.length <= LOG_LIMITS.messageCharacters && !/[\uD800-\uDFFF]/u.test(entry.message)));
});

test('history reads backwards from a cursor and reports whether more is retained', () => {
  const logs = new LogBuffer();
  for (let index = 1; index <= 40; index++) logs.append(index % 2 === 0 ? 'manager' : 'installer', `line ${index}`);

  const tail = logs.readBefore(0, null, 10);
  assert.deepEqual(tail.entries.map((entry) => entry.message), Array.from({ length: 10 }, (_, offset) => `line ${31 + offset}`));
  assert.equal(tail.hasMore, true);

  const older = logs.readBefore(tail.entries[0]!.id, null, 10);
  assert.deepEqual(older.entries.map((entry) => entry.message), Array.from({ length: 10 }, (_, offset) => `line ${21 + offset}`));
  assert.ok(older.entries.at(-1)!.id < tail.entries[0]!.id);

  // A filtered history only walks that source, and the start of the buffer says so.
  const managerOnly = logs.readBefore(0, 'manager', 5);
  assert.ok(managerOnly.entries.every((entry) => entry.source === 'manager'));
  assert.equal(logs.readBefore(2, null, 10).hasMore, false);
});
