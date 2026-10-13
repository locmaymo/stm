import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSearches, foldText, parseQuery, parseSearchRequest, searchChats, searchScope, snippetOf, TermMatcher, type SearchOptions } from '../src/chat-search.js';
import { listChats } from '../../../packages/chats/src/index.js';
import type { ChatSearchDone, ChatSearchEvent, ChatSearchHit } from '../../../packages/contracts/src/index.js';

const NBSP = String.fromCharCode(0xa0);

function matcher(q: string): TermMatcher {
  return new TermMatcher(parseQuery(q));
}

/** The matched parts of `text`, as text. */
function found(q: string, text: string): string[] | null {
  return matcher(q).match(text)?.map(([from, to]) => text.slice(from, to)) ?? null;
}

test('a query is words, with quoted parts kept whole', () => {
  assert.deepEqual(parseQuery('  anh   "yêu  em" Không '), [{ text: 'anh', folded: 'anh' }, { text: 'yêu em', folded: 'yeu em' }, { text: 'Không', folded: 'khong' }]);
  assert.deepEqual(parseQuery('"unclosed quote here').map((term) => term.folded), ['unclosed quote here']);
  assert.deepEqual(parseQuery('khong KHÔNG không ""').map((term) => term.folded), ['khong']);
  assert.deepEqual(parseQuery('a b c d e f g h i j k l m n o p q r s').length, 16);
  assert.deepEqual(parseQuery('   '), []);
});

test('folding takes away accents, case and đ, the same for composed and decomposed text', () => {
  assert.equal(foldText('Không ĐƯỢC đâu'), 'khong duoc dau');
  assert.equal(foldText('Không ĐƯỢC đâu'.normalize('NFD')), 'khong duoc dau');
  assert.equal(foldText('Crème  Brûlée\n\tÇA'), 'creme brulee ca');
  assert.equal(foldText('Ελληνικά Привет'), 'ελληνικα привет');
});

test('words match without accents or case, and in Vietnamese', () => {
  assert.deepEqual(found('khong', 'Không, KHÔNG và không.'), ['Không', 'KHÔNG', 'không']);
  assert.deepEqual(found('khong', 'Không'.normalize('NFD')), ['Không'.normalize('NFD')]);
  assert.deepEqual(found('Không', 'khong'), ['khong']);
  assert.deepEqual(found('di', 'Đi đâu?'), ['Đi']);
  assert.deepEqual(found('dang', 'Đặng Thu'), ['Đặng']);
  assert.deepEqual(found('Đặng', 'dang'), ['dang']);
  assert.deepEqual(found('creme', 'CRÈME brûlée'), ['CRÈME']);
  assert.deepEqual(found('привет', 'Привет!'), ['Привет']);
  assert.equal(found('xin', 'chào'), null);
});

test('every word must be in the message, and a phrase must be there as written', () => {
  assert.deepEqual(found('anh em', 'em nói với anh'), ['em', 'anh']);
  assert.equal(found('anh chị', 'em nói với anh'), null);
  assert.deepEqual(found('"yêu em"', 'Anh yêu\nem lắm'), ['yêu\nem']);
  assert.deepEqual(found('"yeu em"', `anh YÊU${NBSP}EM`), [`YÊU${NBSP}EM`]);
  assert.equal(found('"yêu em"', 'em yêu anh'), null);
  // Overlapping matches are merged into one range.
  assert.deepEqual(found('ana nan', 'banana'), ['anan']);
});

test('the raw look at a chat line never turns down a message that matches', () => {
  const texts = [
    'Không sao đâu, Đặng ơi',
    'Không sao đâu, Đặng ơi'.normalize('NFD'),
    'She said "yêu em" and left\\ again',
    'line one\nline two\ttabbed',
    `non${NBSP}breaking space`,
    'emoji 🙂 then Ünïcödé',
    'path C:\\Users\\Đặng',
  ];
  const queries = ['khong', 'dang oi', '"yeu em"', 'said left', '"one line"', '"line two tabbed"', '"non breaking"', 'unicode', 'users dang', '"sao dau"', 'C:\\Users'];
  for (const text of texts) {
    for (const q of queries) {
      const terms = matcher(q);
      if (!terms.match(text)) continue;
      for (const line of [
        JSON.stringify({ name: 'A', is_user: false, mes: text, extra: {} }),
        JSON.stringify({ name: 'A', mes: 'other', extra: { display_text: text } }),
        // Python writes non-ASCII as escapes and puts spaces after colons.
        `{"name": "A", "mes": ${JSON.stringify(text).replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}}`,
        `{"name": "A", "mes": ${JSON.stringify(text)}}`,
      ]) {
        assert.equal(terms.couldMatch(Buffer.from(line)), true, `${q} in ${line}`);
      }
    }
  }
});

test('the raw look turns down lines whose text does not have the words', () => {
  const terms = matcher('khong');
  assert.equal(terms.couldMatch(Buffer.from(JSON.stringify({ mes: 'chào bạn', swipes: ['không'], extra: { reasoning: 'không' } }))), false);
  assert.equal(terms.couldMatch(Buffer.from(JSON.stringify({ mes: 'chào bạn', extra: { display_text: 'Không' } }))), true);
  // Two `mes` keys: the line is looked at whole.
  assert.equal(terms.couldMatch(Buffer.from(JSON.stringify({ mes: 'chào', variables: { mes: 'không' } }))), true);
});

test('a snippet is cut around the first match, with the matches in it', () => {
  const text = `${'a '.repeat(100)}Không gặp lại\n${'b '.repeat(100)}`;
  const ranges = matcher('khong').match(text)!;
  const { snippet, ranges: shifted } = snippetOf(text, ranges);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  assert.ok(!snippet.includes('\n'));
  assert.equal(shifted.length, 1);
  assert.equal(snippet.slice(shifted[0]![0], shifted[0]![1]), 'Không');
  assert.ok(snippet.length <= 163);
  const short = snippetOf('Không', [[0, 5]]);
  assert.deepEqual(short, { snippet: 'Không', ranges: [[0, 5]] });
  // Never half an emoji at a cut.
  const emoji = `${'🙂'.repeat(100)}x${'🙂'.repeat(100)}`;
  const cut = snippetOf(emoji, [[200, 201]]);
  assert.equal(cut.snippet.slice(cut.ranges[0]![0], cut.ranges[0]![1]), 'x');
  assert.equal([...cut.snippet].every((char) => char.length === 2 || char === 'x' || char === '…'), true);
});

const header = (characterName: string): string => JSON.stringify({ user_name: 'You', character_name: characterName, create_date: '2024-01-01@00h00m00s', chat_metadata: {} });
const line = (name: string, mes: string, sendDate: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, is_user: name === 'You', is_system: false, send_date: sendDate, mes, extra });

async function profile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stm-chat-search-'));
  await mkdir(join(root, 'chats', 'Seraphina'), { recursive: true });
  await mkdir(join(root, 'chats', 'Lina'), { recursive: true });
  await mkdir(join(root, 'group chats'), { recursive: true });
  await mkdir(join(root, 'groups'), { recursive: true });
  const files: Array<[string, string[], number]> = [
    ['chats/Seraphina/old.jsonl', [header('Seraphina'), line('You', 'Không biết nữa', '2024-03-02T10:00:00.000Z'), line('Seraphina', 'Em không biết', '2024-03-02T10:01:00.000Z')], Date.UTC(2024, 2, 2)],
    ['chats/Lina/new.jsonl', [header('Lina'), line('Lina', 'Hello there', '2024-06-01T10:00:00.000Z'), line('You', 'khong sao', '2024-06-01T10:02:00.000Z', { display_text: 'không sao' })], Date.UTC(2024, 5, 1)],
    ['group chats/g1.jsonl', [JSON.stringify({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }), line('Lina', 'Không ai cả', 'May 1, 2024 9:00am')], Date.UTC(2024, 4, 1)],
  ];
  for (const [path, lines, modified] of files) {
    await writeFile(join(root, path), lines.join('\n'));
    await utimes(join(root, path), new Date(modified), new Date(modified));
  }
  await writeFile(join(root, 'groups', 'g.json'), JSON.stringify({ id: 'g', name: 'Party', members: ['Lina.png'], chats: ['g1'] }));
  return root;
}

async function run(root: string, options: SearchOptions, signal = new AbortController().signal): Promise<{ hits: ChatSearchHit[]; events: ChatSearchEvent[]; done: ChatSearchDone }> {
  const events: ChatSearchEvent[] = [];
  const done = await searchChats(root, options, { signal, emit: (event) => { events.push(event); } });
  return { hits: events.filter((event): event is ChatSearchHit => event.type === 'hit'), events, done };
}

test('a search reads every chat, newest first, and says where each hit is', async () => {
  const root = await profile();
  const { hits, events, done } = await run(root, { q: 'khong' });
  assert.deepEqual(hits.map((hit) => [hit.kind, hit.character, hit.group?.name ?? null, hit.chat, hit.index, hit.name, hit.isUser]), [
    ['character', 'Lina', null, 'new', 1, 'You', true],
    ['group', null, 'Party', 'g1', 0, 'Lina', false],
    ['character', 'Seraphina', null, 'old', 0, 'You', true],
    ['character', 'Seraphina', null, 'old', 1, 'Seraphina', false],
  ]);
  // What SillyTavern shows is what is searched first.
  assert.equal(hits[0]!.snippet, 'không sao');
  assert.equal(hits[0]!.characterName, 'Lina');
  assert.equal(hits[1]!.date, new Date(2024, 4, 1, 9, 0).getTime());
  assert.deepEqual(hits[3]!.ranges, [[3, 8]]);
  assert.equal(events[0]!.type, 'progress');
  assert.equal(events.at(-1), done);
  assert.deepEqual({ hits: done.hits, scanned: done.scannedChats, total: done.totalChats, truncated: done.truncated }, { hits: 4, scanned: 3, total: 3, truncated: false });
});

test('a search can be narrowed by who wrote it, when, and which character or group', async () => {
  const root = await profile();
  assert.deepEqual((await run(root, { q: 'khong', who: 'me' })).hits.map((hit) => hit.chat), ['new', 'old']);
  assert.deepEqual((await run(root, { q: 'khong', who: 'them' })).hits.map((hit) => hit.chat), ['g1', 'old']);
  assert.deepEqual((await run(root, { q: 'khong', character: 'Seraphina' })).hits.map((hit) => hit.index), [0, 1]);
  assert.deepEqual((await run(root, { q: 'khong', group: 'g' })).hits.map((hit) => hit.chat), ['g1']);
  const march = await run(root, { q: 'khong', from: Date.UTC(2024, 2, 2, 10, 0, 30), to: Date.UTC(2024, 2, 3) });
  assert.deepEqual(march.hits.map((hit) => [hit.chat, hit.index]), [['old', 1]]);
  // A chat last written well before `from` is not read at all.
  const june = await run(root, { q: 'khong', from: Date.UTC(2024, 5, 1) });
  assert.deepEqual(june.hits.map((hit) => hit.chat), ['new']);
  assert.equal(june.done.totalChats, 1);
});

test('a search stops at its limit and says there was more', async () => {
  const root = await profile();
  const { hits, done } = await run(root, { q: 'khong', limit: 2 });
  assert.deepEqual(hits.map((hit) => hit.chat), ['new', 'g1']);
  assert.equal(done.truncated, true);
  assert.equal(done.hits, 2);
});

test('an aborted search ends with what it had', async () => {
  const root = await profile();
  const controller = new AbortController();
  const events: ChatSearchEvent[] = [];
  const done = await searchChats(root, { q: 'khong' }, { signal: controller.signal, emit: (event) => { events.push(event); if (event.type === 'hit') controller.abort(); } });
  assert.equal(done.truncated, true);
  assert.ok(done.hits >= 1 && done.hits < 4);
});

test('broken and oversized lines are counted, not fatal', async () => {
  const root = await profile();
  await writeFile(join(root, 'chats', 'Lina', 'broken.jsonl'), [header('Lina'), '{nope', line('Lina', `${'A'.repeat(1024 * 1024 + 1)} không`, '2024-01-01T00:00:00.000Z'), line('Lina', 'vẫn không', '2024-01-01T00:00:00.000Z')].join('\n'));
  const { hits, done } = await run(root, { q: 'khong', character: 'Lina' });
  assert.deepEqual(hits.filter((hit) => hit.chat === 'broken').map((hit) => hit.index), [1]);
  assert.equal(done.malformedLines, 1);
  assert.equal(done.oversizedLines, 1);
});

test('the scope lists characters and groups that have chats', async () => {
  const scope = searchScope(await listChats(await profile()));
  assert.deepEqual(scope.characters.map((entry) => [entry.id, entry.chats]), [['Lina', 1], ['Seraphina', 1]]);
  assert.deepEqual(scope.groups.map((entry) => [entry.id, entry.name, entry.chats]), [['g', 'Party', 1]]);
  assert.equal(scope.totalChats, 3);
});

test('one search at a time: the same session replaces its own, another waits', () => {
  const searches = new ChatSearches();
  const first = searches.begin('a')!;
  const second = searches.begin('a')!;
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(searches.begin('b'), null);
  searches.end(first);
  assert.equal(searches.begin('b'), null);
  searches.end(second);
  assert.ok(searches.begin('b'));
});

test('a search request is checked before anything is read', () => {
  assert.deepEqual(parseSearchRequest({ q: 'khong', who: 'me', limit: 50, from: 1, character: 'Lina' }), { request: { q: 'khong', who: 'me', limit: 50, from: 1, character: 'Lina' } });
  for (const body of [null, [], { q: '' }, { q: '   ' }, { q: 'x'.repeat(501) }, { q: 'a', who: 'all' }, { q: 'a', limit: 0 }, { q: 'a', limit: 1.5 }, { q: 'a', from: 'yesterday' }, { q: 'a', character: 5 }]) {
    assert.ok('error' in parseSearchRequest(body), JSON.stringify(body));
  }
});
