import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listChats, MAX_LINE_BYTES, newReadStats, parseSendDate, readMessages, type ChatMessage } from '../src/index.js';

const header = (characterName: string): string => JSON.stringify({ user_name: 'You', character_name: characterName, create_date: '2024-07-12@01h31m37s123ms', chat_metadata: { integrity: 'x' } });
const message = (name: string, mes: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, is_user: name === 'You', is_system: false, send_date: '2024-07-12T01:31:37.000Z', mes, extra });

async function userRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'stm-chats-'));
}

async function collect(path: string, kind: 'character' | 'group', options: Parameters<typeof readMessages>[1] = {}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for await (const item of readMessages({ path, kind }, options)) messages.push(item);
  return messages;
}

test('send dates are read in every shape SillyTavern has written, and nothing else', () => {
  assert.equal(parseSendDate(1720747897123), 1720747897123);
  assert.equal(parseSendDate('1720747897123'), 1720747897123);
  assert.equal(parseSendDate('2024-07-12T01:31:37.123Z'), Date.UTC(2024, 6, 12, 1, 31, 37, 123));
  assert.equal(parseSendDate('2024-07-12T01:31:37+07:00'), Date.UTC(2024, 6, 11, 18, 31, 37));
  assert.equal(parseSendDate('2024-07-12'), new Date(2024, 6, 12).getTime());
  // The old human format, read as this machine's time, as SillyTavern does.
  assert.equal(parseSendDate('June 3, 2024 5:05pm'), new Date(2024, 5, 3, 17, 5).getTime());
  assert.equal(parseSendDate('Jun 3, 2024 12:05am'), new Date(2024, 5, 3, 0, 5).getTime());
  assert.equal(parseSendDate('December 31, 2023 12:59pm'), new Date(2023, 11, 31, 12, 59).getTime());
  // The humanized formats, which SillyTavern reads as UTC.
  assert.equal(parseSendDate('2024-07-12@01h31m37s123ms'), Date.UTC(2024, 6, 12, 1, 31, 37, 123));
  assert.equal(parseSendDate('2024-7-2@01h31m37s'), Date.UTC(2024, 6, 2, 1, 31, 37));
  assert.equal(parseSendDate('2024-6-5 @14h 56m 50s 682ms'), Date.UTC(2024, 5, 5, 14, 56, 50, 682));
  for (const value of [null, undefined, '', '   ', 0, -5, Number.NaN, 'yesterday', 'Smarch 3, 2024 5:05pm', 'February 30, 2024 1:00pm', 'June 3, 2024 5:75pm', '2024-13-01@01h01m01s', '2024-02-30@01h01m01s', { date: 1 }, true]) {
    assert.equal(parseSendDate(value), null, `${JSON.stringify(value)} is not a date`);
  }
});

test('every chat is listed newest first, group chats with their group', async () => {
  const root = await userRoot();
  await mkdir(join(root, 'chats', 'Seraphina'), { recursive: true });
  await mkdir(join(root, 'chats', 'Đặng Thu'), { recursive: true });
  await mkdir(join(root, 'group chats'), { recursive: true });
  await mkdir(join(root, 'groups'), { recursive: true });
  await writeFile(join(root, 'chats', 'Seraphina', 'Seraphina - 2024-07-12@01h31m37s.jsonl'), `${header('Seraphina')}\n`);
  await writeFile(join(root, 'chats', 'Seraphina', 'notes.txt'), 'not a chat');
  await writeFile(join(root, 'chats', 'Đặng Thu', 'Chat mới.jsonl'), `${header('Đặng Thu')}\n`);
  await writeFile(join(root, 'group chats', '1712345.jsonl'), '');
  await writeFile(join(root, 'group chats', '1799999.jsonl'), '');
  await writeFile(join(root, 'group chats', 'orphan.jsonl'), '');
  await writeFile(join(root, 'groups', '1700000.json'), JSON.stringify({ id: '1700000', name: 'Party', members: ['a.png', 'b.png'], chats: ['1712345'], chat_id: '1799999' }));
  await writeFile(join(root, 'groups', 'broken.json'), '{');
  const times = [['chats/Seraphina/Seraphina - 2024-07-12@01h31m37s.jsonl', 3], ['chats/Đặng Thu/Chat mới.jsonl', 5], ['group chats/1712345.jsonl', 1], ['group chats/1799999.jsonl', 4], ['group chats/orphan.jsonl', 2]] as const;
  for (const [path, day] of times) await utimes(join(root, path), new Date(2024, 0, day), new Date(2024, 0, day));
  const listing = await listChats(root);
  assert.deepEqual(listing.chats.map((chat) => [chat.kind, chat.character, chat.groupId, chat.name]), [
    ['character', 'Đặng Thu', null, 'Chat mới'],
    ['group', null, '1700000', '1799999'],
    ['character', 'Seraphina', null, 'Seraphina - 2024-07-12@01h31m37s'],
    ['group', null, null, 'orphan'],
    ['group', null, '1700000', '1712345'],
  ]);
  assert.deepEqual(listing.groups.map((group) => [group.id, group.name, group.chats]), [['1700000', 'Party', ['1712345', '1799999']]]);
});

test('a directory without chats lists nothing rather than failing', async () => {
  assert.deepEqual(await listChats(join(await userRoot(), 'missing')), { chats: [], groups: [] });
});

test('a legacy public/ profile is listed from its own root', async () => {
  // Old SillyTavern kept the reader's data straight in public/; the profile's
  // user root is that directory, and the layout below it is the same.
  const root = join(await userRoot(), 'public');
  await mkdir(join(root, 'chats', 'Old'), { recursive: true });
  await writeFile(join(root, 'chats', 'Old', 'first.jsonl'), `${header('Old')}\n${message('Old', 'hello')}\n`);
  const listing = await listChats(root);
  assert.deepEqual(listing.chats.map((chat) => chat.name), ['first']);
  assert.deepEqual((await collect(listing.chats[0]!.path, 'character')).map((item) => item.text), ['hello']);
});

test('messages are numbered the way SillyTavern numbers them', async () => {
  const root = await userRoot();
  const path = join(root, 'chat.jsonl');
  // Blank lines, a broken line and a CRLF line ending; SillyTavern drops what is not JSON.
  await writeFile(path, [header('Seraphina'), message('Seraphina', 'zero'), '', '{broken', `${message('You', 'one', { display_text: 'một' })}\r`, 'null', message('Seraphina', 'two'), ''].join('\n'));
  const stats = newReadStats();
  const messages = await collect(path, 'character', { stats });
  assert.deepEqual(messages.map((item) => [item.index, item.name, item.isUser, item.text, item.shownText]), [
    [0, 'Seraphina', false, 'zero', null],
    [1, 'You', true, 'one', 'một'],
    [2, 'Seraphina', false, 'two', null],
  ]);
  assert.equal(messages[0]?.sendDate, Date.UTC(2024, 6, 12, 1, 31, 37));
  assert.deepEqual({ messages: stats.messages, malformed: stats.malformed, header: stats.header }, { messages: 3, malformed: 1, header: { userName: 'You', characterName: 'Seraphina', createDate: Date.UTC(2024, 6, 12, 1, 31, 37, 123) } });
});

test('a header written by another program is still read as the header', async () => {
  const path = join(await userRoot(), 'chat.jsonl');
  await writeFile(path, [JSON.stringify({ chat_metadata: {}, character_name: 'Lina', user_name: 'You' }), message('Lina', 'zero')].join('\n'));
  const stats = newReadStats();
  assert.deepEqual((await collect(path, 'character', { stats })).map((item) => item.index), [0]);
  assert.equal(stats.header?.characterName, 'Lina');
});

test('a group chat has a header only when its first line carries chat_metadata', async () => {
  const root = await userRoot();
  const withHeader = join(root, 'new.jsonl');
  const withoutHeader = join(root, 'old.jsonl');
  await writeFile(withHeader, [JSON.stringify({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }), message('A', 'first'), message('B', 'second')].join('\n'));
  await writeFile(withoutHeader, [message('A', 'first'), message('B', 'second')].join('\n'));
  const stats = newReadStats();
  assert.deepEqual((await collect(withHeader, 'group', { stats })).map((item) => [item.index, item.text]), [[0, 'first'], [1, 'second']]);
  assert.deepEqual(stats.header, { userName: null, characterName: null, createDate: null });
  assert.deepEqual((await collect(withoutHeader, 'group')).map((item) => [item.index, item.text]), [[0, 'first'], [1, 'second']]);
});

test('a line too long to read is counted and passed over, keeping the numbers after it', async () => {
  const path = join(await userRoot(), 'chat.jsonl');
  const picture = message('Seraphina', 'look', { image: `data:image/png;base64,${'A'.repeat(MAX_LINE_BYTES + 10)}` });
  await writeFile(path, [header('Seraphina'), message('You', 'zero'), picture, message('Seraphina', 'two'), picture].join('\n'));
  const stats = newReadStats();
  // A small buffer, so lines also run across reads.
  const messages = await collect(path, 'character', { stats, buffer: Buffer.alloc(97) });
  assert.deepEqual(messages.map((item) => [item.index, item.text]), [[0, 'zero'], [2, 'two']]);
  assert.deepEqual({ messages: stats.messages, oversized: stats.oversized }, { messages: 4, oversized: 2 });
});

test('lines split across reads come out whole, whatever the buffer size', async () => {
  const path = join(await userRoot(), 'chat.jsonl');
  const texts = ['Không sao đâu', 'emoji 🙂 here', 'x'.repeat(500), 'last'];
  await writeFile(path, [header('Seraphina'), ...texts.map((text) => message('Seraphina', text))].join('\n'));
  for (const size of [1, 7, 64, 4096]) {
    assert.deepEqual((await collect(path, 'character', { buffer: Buffer.alloc(size) })).map((item) => item.text), texts, `buffer of ${size}`);
  }
});

test('a line the prefilter turns down is counted and not parsed', async () => {
  const path = join(await userRoot(), 'chat.jsonl');
  await writeFile(path, [header('Seraphina'), message('You', 'skip me'), message('Seraphina', 'keep me')].join('\n'));
  const seen: string[] = [];
  const messages = await collect(path, 'character', { prefilter: (line) => { seen.push(line.toString('utf8')); return line.includes('keep'); } });
  assert.deepEqual(messages.map((item) => [item.index, item.text]), [[1, 'keep me']]);
  // The header is never offered to it.
  assert.equal(seen.length, 2);
});

test('reading stops when the signal is aborted', async () => {
  const path = join(await userRoot(), 'chat.jsonl');
  await writeFile(path, [header('Seraphina'), ...Array.from({ length: 50 }, (_, index) => message('Seraphina', `line ${index}`))].join('\n'));
  const controller = new AbortController();
  const messages: ChatMessage[] = [];
  for await (const item of readMessages({ path, kind: 'character' }, { signal: controller.signal, buffer: Buffer.alloc(256) })) {
    messages.push(item);
    if (messages.length === 3) controller.abort();
  }
  assert.equal(messages.length, 3);
});
