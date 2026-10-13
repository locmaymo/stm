import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatExists, ChatOpenTokens, OPEN_SCRIPT, openAnswer, parseOpenRequest, type ChatOpenTarget } from '../src/chat-open.js';

const target: ChatOpenTarget = { kind: 'character', character: 'Lina', group: null, chat: 'first', index: 3, title: 'Lina' };

test('a token stands for one message until it runs out', () => {
  let now = 1_000;
  const tokens = new ChatOpenTokens(() => now);
  const token = tokens.issue(target);
  assert.match(token, /^[A-Za-z0-9_-]{24}$/u);
  assert.deepEqual(tokens.target(token), target);
  assert.equal(tokens.target('x'.repeat(24)), null);
  assert.equal(tokens.target('../../etc'), null);
  now += 10 * 60 * 1000;
  assert.equal(tokens.target(token), null);
});

test('only so many tokens are kept, the oldest going first', () => {
  const tokens = new ChatOpenTokens(() => 0);
  const first = tokens.issue(target);
  const rest = Array.from({ length: 64 }, (_, index) => tokens.issue({ ...target, index }));
  assert.equal(tokens.target(first), null);
  assert.equal(tokens.target(rest.at(-1)!)?.index, 63);
});

test('a request names one chat, by names that are one path segment each', () => {
  assert.deepEqual(parseOpenRequest({ kind: 'character', character: 'Lina', chat: 'first', index: 3, title: '  Lina  ' }), { target });
  assert.deepEqual(parseOpenRequest({ kind: 'group', group: '1714549999', chat: '1714550000', index: 0 }), { target: { kind: 'group', character: null, group: '1714549999', chat: '1714550000', index: 0, title: null } });
  for (const body of [null, { kind: 'x' }, { kind: 'character', chat: 'a', index: 0 }, { kind: 'character', character: '..', chat: 'a', index: 0 }, { kind: 'character', character: 'a/b', chat: 'c', index: 0 }, { kind: 'character', character: 'a', chat: '..\\x', index: 0 }, { kind: 'group', chat: 'a', index: 0 }, { kind: 'character', character: 'a', chat: 'b', index: -1 }, { kind: 'character', character: 'a', chat: 'b', index: 1.5 }]) {
    assert.ok('error' in parseOpenRequest(body), JSON.stringify(body));
  }
});

test('a chat is only opened when it is there', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-chat-open-'));
  await mkdir(join(root, 'chats', 'Lina'), { recursive: true });
  await mkdir(join(root, 'group chats'), { recursive: true });
  await writeFile(join(root, 'chats', 'Lina', 'first.jsonl'), '');
  await writeFile(join(root, 'group chats', 'g1.jsonl'), '');
  assert.equal(await chatExists(root, target), true);
  assert.equal(await chatExists(root, { ...target, chat: 'second' }), false);
  assert.equal(await chatExists(root, { kind: 'group', character: null, group: 'g', chat: 'g1', index: 0, title: null }), true);
});

test('the page is told the card file, as SillyTavern lists characters', () => {
  assert.deepEqual(openAnswer(target), { kind: 'character', avatar: 'Lina.png', group: null, chat: 'first', index: 3, title: 'Lina' });
  assert.doesNotThrow(() => new Function(OPEN_SCRIPT));
});
