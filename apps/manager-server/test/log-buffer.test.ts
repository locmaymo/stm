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

test('a burst larger than one answer is caught up rather than lost', () => {
  const logs = new LogBuffer();
  // What an installer does between two polls: more lines than one answer holds.
  const burst = LOG_LIMITS.responseEntries * 2 + 30;
  for (let index = 1; index <= burst; index++) logs.append('installer', `line ${index}`);

  // A console that has just opened is given the end of the buffer. Replaying
  // everything retained to fill a card is neither useful nor cheap.
  const opened = logs.read(0, null);
  assert.equal(opened.entries.length, LOG_LIMITS.responseEntries);
  assert.equal(opened.entries.at(-1)?.message, `line ${burst}`);

  // A console that is following is given the next page in order, and the
  // cursor stops at the last line it was actually handed - so what the cap
  // left behind arrives on the polls that follow instead of being skipped.
  const first = logs.read(1, null);
  assert.equal(first.entries.length, LOG_LIMITS.responseEntries);
  assert.equal(first.entries[0]?.message, 'line 2');
  assert.equal(first.nextCursor, first.entries.at(-1)?.id);
  assert.ok(first.nextCursor < burst, 'a truncated answer must not claim to have delivered the whole log');

  const second = logs.read(first.nextCursor, null);
  assert.equal(second.entries[0]?.message, `line ${LOG_LIMITS.responseEntries + 2}`);

  // Following it to the end loses nothing and stops.
  const seen: string[] = [...first.entries, ...second.entries].map((entry) => entry.message);
  let cursor = second.nextCursor;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = logs.read(cursor, null);
    if (page.entries.length === 0) break;
    seen.push(...page.entries.map((entry) => entry.message));
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, Array.from({ length: burst - 1 }, (_, offset) => `line ${offset + 2}`));
});

test('an answer that carried everything says so, whatever was filtered out of it', () => {
  const logs = new LogBuffer();
  logs.append('manager', 'Started');
  for (let index = 0; index < 20; index++) logs.append('installer', `line ${index}`);

  // Nothing was left behind for this source, so the cursor moves past every
  // line written - including the ones of other sources it skipped. Holding it
  // back at the last match would make a console following a quiet source ask
  // again for lines it has already been told about.
  const manager = logs.read(0, 'manager');
  assert.equal(manager.entries.length, 1);
  assert.equal(manager.nextCursor, 21);
  assert.deepEqual(logs.read(manager.nextCursor, 'manager').entries, []);
});
