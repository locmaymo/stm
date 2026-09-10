import test from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer, LOG_LIMITS } from '../src/log-buffer.js';

test('combined logs preserve ordering, filter sources, and advance the shared cursor', () => {
  const logs = new LogBuffer();
  logs.append('manager', 'Started');
  logs.append('installer', '\u001b[32mInstalling\u001b[0m');
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
  for (let index = 0; index < 400; index++) largeLogs.append('installer', '🙂'.repeat(4_096));
  const retained = largeLogs.read(0, null).entries;
  assert.ok(retained.length < 400);
  assert.ok(retained.reduce((sum, entry) => sum + entry.message.length, 0) <= LOG_LIMITS.totalCharacters);
  assert.ok(retained.every((entry) => entry.message.length <= LOG_LIMITS.messageCharacters && !/[\ud800-\udfff]/u.test(entry.message)));
});
