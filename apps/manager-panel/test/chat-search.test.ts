import test from 'node:test';
import assert from 'node:assert/strict';
import { chatKey, dayEnd, dayStart, groupHits, highlightParts, LineSplitter } from '../src/chat-search.js';
import type { ChatSearchHit } from '../../../packages/contracts/src/index.js';

function hit(chat: string, index: number, character: string | null = 'Lina', group: { id: string; name: string } | null = null): ChatSearchHit {
  return { type: 'hit', kind: group ? 'group' : 'character', chat, character: group ? null : character, characterName: null, group, chatModified: 0, index, date: null, name: 'Lina', isUser: false, snippet: 'x', ranges: [] };
}

test('lines come out whole however the stream is cut', () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(splitter.push(':2}\n\n'), ['{"b":2}']);
  assert.deepEqual(splitter.push('{"c":3}'), []);
  assert.deepEqual(splitter.end(), ['{"c":3}']);
  assert.deepEqual(splitter.end(), []);
});

test('a snippet is cut into plain parts and matches', () => {
  assert.deepEqual(highlightParts('Không sao đâu', [[0, 5], [10, 13]]), [
    { text: 'Không', match: true },
    { text: ' sao ', match: false },
    { text: 'đâu', match: true },
  ]);
  assert.deepEqual(highlightParts('abc', []), [{ text: 'abc', match: false }]);
  // Ranges out of order, overlapping or past the end do not repeat or lose text.
  assert.deepEqual(highlightParts('abcdef', [[4, 9], [1, 3], [2, 4]]).map((part) => part.text).join(''), 'abcdef');
});

test('hits are grouped by chat, in the order the chats arrived', () => {
  const party = { id: 'g', name: 'Party' };
  let groups = groupHits([], [hit('new', 1), hit('old', 0, 'Seraphina')]);
  groups = groupHits(groups, [hit('new', 4), hit('g1', 2, null, party), hit('new', 0, 'Other')]);
  assert.deepEqual(groups.map((group) => group.hits.map((item) => item.index)), [[1, 4], [0], [2], [0]]);
  assert.notEqual(chatKey(hit('a', 0, 'x')), chatKey(hit('a', 0, null, { id: 'x', name: 'x' })));
});

test('a picked day runs from its start here to the start of the next', () => {
  assert.equal(dayStart('2024-03-02'), new Date(2024, 2, 2).getTime());
  assert.equal(dayEnd('2024-03-02'), new Date(2024, 2, 3).getTime());
  assert.equal(dayEnd('2024-12-31'), new Date(2025, 0, 1).getTime());
  assert.equal(dayStart(''), null);
  assert.equal(dayEnd('not a day'), null);
});
