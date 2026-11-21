import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planSync, sameContent, type SyncAction, type SyncPlan, type SyncPlanInput } from '../src/sync-plan.js';
import { CHUNK_BYTES, type HashedFile } from '../src/sync.js';

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A one-chunk file whose content is the given text. */
function file(name: string, content: string, mtimeMs = 1): HashedFile {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  return { name, sizeBytes, mtimeMs, chunks: sizeBytes === 0 ? [] : [{ hash: hashOf(content), offset: 0, length: sizeBytes }] };
}

/** A file of several chunks, each named by a label, the last one `tailBytes` long. */
function chunked(name: string, labels: readonly string[], tailBytes: number): HashedFile {
  const chunks = labels.map((label, at) => ({ hash: hashOf(label), offset: at * CHUNK_BYTES, length: at === labels.length - 1 ? tailBytes : CHUNK_BYTES }));
  return { name, sizeBytes: (labels.length - 1) * CHUNK_BYTES + tailBytes, mtimeMs: 1, chunks };
}

function plan(parts: Partial<SyncPlanInput>): SyncPlan {
  return planSync({ base: [], local: [], head: [], copyTag: 'phone 2026-11-16 14-05', windowsNames: false, caseInsensitive: false, ...parts });
}

function kinds(result: SyncPlan): string[] {
  return result.actions.map((action: SyncAction) => `${action.kind} ${action.name}`);
}

const CARD = 'characters/Seraphina.png';

/**
 * Every way one file can differ between the base, this device and the head.
 * `-` is "not there"; a letter is a version of the content.
 */
const TABLE: readonly { readonly title: string; readonly base: string; readonly local: string; readonly head: string; readonly actions: readonly string[]; readonly push: boolean }[] = [
  { title: 'nothing changed anywhere', base: 'a', local: 'a', head: 'a', actions: [], push: false },
  { title: 'another device changed it', base: 'a', local: 'a', head: 'b', actions: [`take ${CARD}`], push: false },
  { title: 'this device changed it', base: 'a', local: 'b', head: 'a', actions: [], push: true },
  { title: 'both made the same change', base: 'a', local: 'b', head: 'b', actions: [], push: false },
  { title: 'both changed it differently', base: 'a', local: 'b', head: 'c', actions: [`setAside ${CARD}`], push: false },
  { title: 'another device deleted it', base: 'a', local: 'a', head: '-', actions: [`remove ${CARD}`], push: false },
  { title: 'this device deleted it', base: 'a', local: '-', head: 'a', actions: [], push: true },
  { title: 'changed here, deleted there: the change wins', base: 'a', local: 'b', head: '-', actions: [], push: true },
  { title: 'deleted here, changed there: the change wins', base: 'a', local: '-', head: 'b', actions: [`take ${CARD}`], push: false },
  { title: 'both deleted it', base: 'a', local: '-', head: '-', actions: [], push: false },
  { title: 'new on another device', base: '-', local: '-', head: 'a', actions: [`take ${CARD}`], push: false },
  { title: 'new on this device', base: '-', local: 'a', head: '-', actions: [], push: true },
  { title: 'both added the same file', base: '-', local: 'a', head: 'a', actions: [], push: false },
  { title: 'both added a different file under one name', base: '-', local: 'a', head: 'b', actions: [`setAside ${CARD}`], push: false },
];

for (const row of TABLE) {
  test(`one file: ${row.title}`, () => {
    const side = (version: string): HashedFile[] => (version === '-' ? [] : [file(CARD, version)]);
    const result = plan({ base: side(row.base), local: side(row.local), head: side(row.head) });
    assert.deepEqual(kinds(result), row.actions);
    assert.equal(result.push, row.push);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.carried, []);
  });
}

test('a timestamp alone is not a change', () => {
  const result = plan({ base: [file(CARD, 'a', 1)], local: [file(CARD, 'a', 2)], head: [file(CARD, 'a', 3)] });
  assert.deepEqual(result.actions, []);
  assert.equal(result.push, false);
  assert.equal(sameContent(file(CARD, 'a', 1), file(CARD, 'a', 9)), true);
  assert.equal(sameContent(file(CARD, ''), file(CARD, '')), true);
  assert.equal(sameContent(file(CARD, 'a'), file(CARD, 'b')), false);
});

test('a device that never synced treats every difference as two additions', () => {
  const result = plan({
    base: null,
    local: [file('settings.json', 'mine'), file('characters/Only here.png', 'x'), file('worlds/Shared.json', 'same')],
    head: [file('settings.json', 'theirs'), file('characters/Only there.png', 'y'), file('worlds/Shared.json', 'same')],
  });
  assert.deepEqual(kinds(result), ['take characters/Only there.png', 'setAside settings.json']);
  assert.equal(result.push, true);
});

test('a chat both devices wrote to is kept twice, never merged', () => {
  const name = 'chats/Seraphina/Seraphina - 2026-11-01@10h00m00s.jsonl';
  const result = plan({ base: [file(name, 'a')], local: [file(name, 'a-then-phone')], head: [file(name, 'a-then-pc!')] });
  assert.equal(result.actions.length, 1);
  const [action] = result.actions;
  assert.ok(action?.kind === 'keepBoth');
  assert.equal(action.as, 'chats/Seraphina/Seraphina - 2026-11-01@10h00m00s (phone 2026-11-16 14-05).jsonl');
  assert.equal(action.chat, 'character');
  assert.equal(action.head.chunks[0]?.hash, hashOf('a-then-pc!'));
  assert.equal(action.local.chunks[0]?.hash, hashOf('a-then-phone'));
  // The second chat exists only here until it is sent.
  assert.equal(result.push, true);
});

test('a group chat is kept twice and says it belongs to a group', () => {
  const name = 'group chats/2026-11-01@10h00m00s.jsonl';
  const result = plan({ base: [file(name, 'a')], local: [file(name, 'b')], head: [file(name, 'cc')] });
  const [action] = result.actions;
  assert.ok(action?.kind === 'keepBoth');
  assert.equal(action.chat, 'group');
  assert.equal(action.as, 'group chats/2026-11-01@10h00m00s (phone 2026-11-16 14-05).jsonl');
});

test('a file that is not a chat is never kept twice, even inside the chats folder', () => {
  const name = 'chats/Seraphina/notes.txt';
  const result = plan({ base: [file(name, 'a')], local: [file(name, 'b')], head: [file(name, 'c')] });
  assert.deepEqual(kinds(result), [`setAside ${name}`]);
});

test('the copy of a chat gets a name nothing else has', () => {
  const name = 'chats/A/talk.jsonl';
  const first = 'chats/A/talk (phone 2026-11-16 14-05).jsonl';
  const second = 'chats/A/talk (phone 2026-11-16 14-05 2).jsonl';
  const result = plan({
    base: [file(name, 'a')],
    local: [file(name, 'b'), file(first, 'earlier copy')],
    head: [file(name, 'c'), file(first, 'earlier copy'), file(second, 'another')],
  });
  const kept = result.actions.find((action) => action.kind === 'keepBoth');
  assert.ok(kept?.kind === 'keepBoth');
  assert.equal(kept.as, 'chats/A/talk (phone 2026-11-16 14-05 3).jsonl');
});

test('a device label cannot put characters in the name that some device would refuse', () => {
  const name = 'chats/A/talk.jsonl';
  const result = plan({ base: [file(name, 'a')], local: [file(name, 'b')], head: [file(name, 'c')], copyTag: '  PC: "nhà"/<1>?  14:05. ' });
  const [action] = result.actions;
  assert.ok(action?.kind === 'keepBoth');
  assert.equal(action.as, 'chats/A/talk (PC nhà 1 14 05).jsonl');
});

test('an empty device label still gives the copy a name', () => {
  const name = 'chats/A/talk.jsonl';
  const result = plan({ base: [file(name, 'a')], local: [file(name, 'b')], head: [file(name, 'c')], copyTag: ' ?? ' });
  const [action] = result.actions;
  assert.ok(action?.kind === 'keepBoth');
  assert.equal(action.as, 'chats/A/talk (copy).jsonl');
});

test('Vietnamese names survive, and a very long one is cut between characters', () => {
  const short = 'chats/Nguyễn Thị Hồng/Trò chuyện đầu tiên.jsonl';
  const long = `chats/Nguyễn Thị Hồng/${'ễ'.repeat(120)}.jsonl`;
  const result = plan({
    base: [file(short, 'a'), file(long, 'a')],
    local: [file(short, 'b'), file(long, 'b')],
    head: [file(short, 'c'), file(long, 'c')],
    copyTag: 'điện thoại 2026-11-16 14-05',
  });
  const names = result.actions.map((action) => (action.kind === 'keepBoth' ? action.as : ''));
  assert.equal(names.length, 2);
  assert.ok(names.includes('chats/Nguyễn Thị Hồng/Trò chuyện đầu tiên (điện thoại 2026-11-16 14-05).jsonl'));
  const cut = names.find((name) => name.includes('ễễ'));
  assert.ok(cut);
  const leaf = cut.slice(cut.lastIndexOf('/') + 1);
  assert.ok(Buffer.byteLength(leaf, 'utf8') <= 200);
  assert.ok(leaf.endsWith(' (điện thoại 2026-11-16 14-05).jsonl'));
  assert.equal(leaf.includes('\uFFFD'), false);
  assert.equal(leaf, leaf.normalize('NFC'));
});

test('a chat that only grew on one side says which side may hold all of the other', () => {
  const name = 'chats/A/talk.jsonl';
  const grown = plan({ base: null, local: [file(name, 'one\n')], head: [file(name, 'one\ntwo\n')] });
  const [small] = grown.actions;
  assert.ok(small?.kind === 'keepBoth');
  assert.equal(small.mayExtend, 'head');

  // Past one chunk, the chunks the shorter file filled must match in place.
  const agree = plan({ base: null, local: [chunked(name, ['c0', 'c1', 'tail-long'], 900)], head: [chunked(name, ['c0', 'tail-short'], 100)] });
  const [matching] = agree.actions;
  assert.ok(matching?.kind === 'keepBoth');
  assert.equal(matching.mayExtend, 'local');

  const differ = plan({ base: null, local: [chunked(name, ['c0', 'c1', 'tail-long'], 900)], head: [chunked(name, ['other', 'tail-short'], 100)] });
  const [diverged] = differ.actions;
  assert.ok(diverged?.kind === 'keepBoth');
  assert.equal(diverged.mayExtend, null);

  const sameSize = plan({ base: null, local: [file(name, 'abc')], head: [file(name, 'xyz')] });
  const [level] = sameSize.actions;
  assert.ok(level?.kind === 'keepBoth');
  assert.equal(level.mayExtend, null);
});

test('the port and listen address of one device never reach another', () => {
  const result = plan({
    base: [file('config.yaml', 'port: 8000')],
    local: [file('config.yaml', 'port: 8002')],
    head: [file('config.yaml', 'port: 8000-pc'), file('config.yml', 'old')],
  });
  assert.deepEqual(result.actions, []);
  assert.equal(result.push, false);
  const gone = plan({ base: [file('config.yaml', 'a')], local: [file('config.yaml', 'a')], head: [] });
  assert.deepEqual(gone.actions, []);
});

test('a name that would leave the profile is never written', () => {
  const head = [file('../outside.txt', 'x'), file('chats//double.jsonl', 'x'), file('./here.txt', 'x'), file('a/../b.txt', 'x'), file('nul\u0000byte', 'x'), file('worlds/Fine.json', 'x')];
  const result = plan({ head });
  assert.deepEqual(kinds(result), ['take worlds/Fine.json']);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['unsafe_name', 'unsafe_name', 'unsafe_name', 'unsafe_name', 'unsafe_name']);
  // They are carried, so this device's next file list does not read as deleting them.
  assert.equal(result.carried.length, 5);
});

test('names Windows refuses are skipped there and taken everywhere else', () => {
  const head = [
    file('chats/A/what?.jsonl', 'x'),
    file('chats/A/10:30.jsonl', 'x'),
    file('characters/aux.png', 'x'),
    file('characters/COM1', 'x'),
    file('worlds/trailing dot./a.json', 'x'),
    file('worlds/trailing space /a.json', 'x'),
    file('back\\slash.txt', 'x'),
    file('C:/Users/x.txt', 'x'),
    file('characters/auxiliary.png', 'x'),
    file('worlds/Fine.json', 'x'),
  ];
  const windows = plan({ head, windowsNames: true, caseInsensitive: true });
  assert.deepEqual(kinds(windows), ['take characters/auxiliary.png', 'take worlds/Fine.json']);
  assert.equal(windows.skipped.length, 8);
  assert.equal(windows.carried.length, 8);
  assert.equal(windows.skipped.find((entry) => entry.name === 'C:/Users/x.txt')?.reason, 'unsafe_name');
  assert.equal(windows.skipped.find((entry) => entry.name === 'characters/aux.png')?.reason, 'invalid_name');

  const elsewhere = plan({ head });
  assert.equal(elsewhere.actions.length, head.length);
  assert.deepEqual(elsewhere.skipped, []);
});

test('two names that differ only by case cannot both land on a device that folds case', () => {
  const head = [file('characters/Alice.png', 'one'), file('characters/alice.png', 'two')];
  const folding = plan({ head, caseInsensitive: true });
  assert.deepEqual(kinds(folding), ['take characters/Alice.png']);
  assert.deepEqual(folding.skipped, [{ name: 'characters/alice.png', reason: 'case_collision' }]);
  assert.deepEqual(folding.carried.map((entry) => entry.name), ['characters/alice.png']);

  const exact = plan({ head });
  assert.equal(exact.actions.length, 2);

  // A file already here holds the name against a newcomer.
  const held = plan({ local: [file('characters/ALICE.png', 'mine')], head: [file('characters/alice.png', 'two')], base: null, caseInsensitive: true });
  assert.deepEqual(held.actions, []);
  assert.deepEqual(held.skipped, [{ name: 'characters/alice.png', reason: 'case_collision' }]);
});

test('a rename that only changes case is a removal followed by a write', () => {
  const result = plan({ base: [file('characters/alice.png', 'a')], local: [file('characters/alice.png', 'a')], head: [file('characters/Alice.png', 'a')], caseInsensitive: true });
  assert.deepEqual(kinds(result), ['remove characters/alice.png', 'take characters/Alice.png']);
  assert.deepEqual(result.skipped, []);
});

test('removals come first and the plan is the same whatever order the lists arrive in', () => {
  const base = [file('worlds/Gone.json', 'a'), file('settings.json', 'a'), file('chats/A/talk.jsonl', 'a')];
  const local = [file('worlds/Gone.json', 'a'), file('settings.json', 'mine'), file('chats/A/talk.jsonl', 'mine'), file('characters/New here.png', 'n')];
  const head = [file('settings.json', 'theirs'), file('chats/A/talk.jsonl', 'theirs!'), file('characters/New there.png', 'm'), file('backgrounds/sky.jpg', 'j')];
  const forward = plan({ base, local, head });
  const backward = plan({ base: [...base].reverse(), local: [...local].reverse(), head: [...head].reverse() });
  assert.deepEqual(forward, backward);
  assert.deepEqual(kinds(forward), [
    'remove worlds/Gone.json',
    'take backgrounds/sky.jpg',
    'take characters/New there.png',
    'keepBoth chats/A/talk.jsonl',
    'setAside settings.json',
  ]);
  assert.equal(forward.push, true);
});

test('a device with nothing takes everything and has nothing to send', () => {
  const head = [file('settings.json', 's'), file('chats/A/talk.jsonl', 'c'), file('characters/A.png', 'p')];
  const result = plan({ base: null, local: [], head });
  assert.deepEqual(kinds(result), ['take characters/A.png', 'take chats/A/talk.jsonl', 'take settings.json']);
  assert.equal(result.push, false);
});
