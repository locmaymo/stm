import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageEvent } from '../../../packages/contracts/src/index.js';
import { parseReplyReport, ReplyNotifier, type ReplyReport } from '../src/replies.js';
import type { NotificationLocale } from '../src/notifications.js';
import type { PushMessage } from '../src/web-push.js';

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

const ANSWER: UsageEvent = { schemaVersion: 1, timestamp: '2026-10-12T10:00:00.000Z', provider: 'openai', completionSource: 'openai', model: 'gpt-test', endpointHost: 'api.openai.com', stream: true, maxTokens: null, inputTokens: 10, outputTokens: 20, totalTokens: 30, status: 200, durationMs: 900 };

const REPORT: ReplyReport = { page: 'phone', title: 'Seraphina', name: 'Seraphina', group: false, text: 'You are safe here.\n\nRest now.', avatar: 'Seraphina.png', key: 'c:Seraphina.png', chat: 'Seraphina - 2026-10-12' };

/** A notifier whose pushes are written down in English and Vietnamese, as two phones would read them. */
function notifier(metricsFile = join(tmpdir(), 'stm-replies-none.jsonl'), options: { pollMs?: number } = {}) {
  const told: Array<Record<NotificationLocale | 'hidden', PushMessage>> = [];
  const replies = new ReplyNotifier({
    metricsFile,
    graceMs: 30,
    ...(options.pollMs ? { pollMs: options.pollMs } : {}),
    // A third phone asked not to be shown what was said.
    deliver: async (message) => { told.push({ en: message('en', true), vi: message('vi', true), hidden: message('en', false) }); },
  });
  return { replies, told };
}

test('a reply the page saw is told at once, with who said what and where to open it', async (t) => {
  const { replies, told } = notifier();
  t.after(() => replies.close());
  replies.presence('phone', 'hidden');
  await replies.reply(REPORT);
  assert.equal(told.length, 1);
  const message = told[0]!.en;
  assert.equal(message.title, 'Seraphina');
  assert.equal(message.body, 'You are safe here. Rest now.', 'on one line, as a lock screen shows it');
  assert.equal(message.tag, 'reply:c:Seraphina.png', 'one conversation, one notification');
  assert.equal(message.url, '/#stm-open=c%3ASeraphina.png&chat=Seraphina%20-%202026-10-12');
  assert.equal(message.icon, '/thumbnail?type=avatar&file=Seraphina.png');
  assert.equal(told[0]!.hidden.body, 'Seraphina replied.', 'a phone that asked not to be shown what was said is told only who');
  assert.equal(told[0]!.hidden.title, 'Seraphina');

  await replies.reply({ ...REPORT, text: 'a'.repeat(400), group: true, title: 'The tavern', name: 'Seraphina', key: 'g:1700' });
  const group = told[1]!.vi;
  assert.equal(group.title, 'The tavern');
  assert.ok(group.body.startsWith('Seraphina: aaa'), 'in a group, who spoke');
  assert.ok(group.body.length < 140 && group.body.endsWith('…'), 'and only the start of it');
  assert.equal(told[1]!.hidden.body, 'Seraphina replied.');

  await replies.reply({ ...REPORT, text: '' });
  assert.equal(told[2]!.vi.body, 'Seraphina đã trả lời.', 'a reply with nothing to show still says who');
});

test('nothing is told while somebody is looking at SillyTavern somewhere', async (t) => {
  const { replies, told } = notifier();
  t.after(() => replies.close());
  replies.presence('desk', 'visible');
  replies.presence('phone', 'hidden');
  await replies.reply(REPORT);
  replies.answer(ANSWER);
  await wait(80);
  assert.equal(told.length, 0);
});

test('an answer nobody saw arrive is told in plain words once the page had its chance', async (t) => {
  const { replies, told } = notifier();
  t.after(() => replies.close());
  replies.presence('phone', 'hidden');
  replies.answer(ANSWER);
  assert.equal(told.length, 0, 'not at once: the page may still say it better');
  await wait(80);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.en.body, 'A reply is ready.');
  assert.equal(told[0]!.vi.body, 'Đã có câu trả lời.');
  assert.equal(told[0]!.en.tag, 'reply');
  assert.equal(told[0]!.en.url, '/');

  // Several requests make one reply: the plain words are not said again straight away.
  replies.answer({ ...ANSWER, cut: true });
  await wait(80);
  assert.equal(told.length, 1);
});

test('an answer that was cut short or failed says so', async (t) => {
  const cases: ReadonlyArray<readonly [UsageEvent, string]> = [
    [{ ...ANSWER, cut: true }, 'The reply stopped before it finished. Open SillyTavern to see what arrived.'],
    [{ ...ANSWER, status: 429 }, 'The reply did not come through. Open SillyTavern to try again.'],
    [{ ...ANSWER, status: null }, 'The reply did not come through. Open SillyTavern to try again.'],
  ];
  for (const [event, words] of cases) {
    const { replies, told } = notifier();
    t.after(() => replies.close());
    replies.presence('phone', 'hidden');
    replies.answer(event);
    await wait(80);
    assert.equal(told[0]?.en.body, words);
    assert.equal(told[0]?.en.level, 'warning');
  }
});

test('the page telling a reply covers the same answer in the log, whichever comes first', async (t) => {
  const { replies, told } = notifier();
  t.after(() => replies.close());
  replies.presence('phone', 'hidden');
  replies.answer(ANSWER);
  await replies.reply(REPORT);
  replies.answer(ANSWER);
  await wait(80);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.en.title, 'Seraphina');
});

test('nothing is told when no page ever said where it was', async (t) => {
  // SillyTavern opened on its own port, past the door: nobody can tell whether it is looked at.
  const { replies, told } = notifier();
  t.after(() => replies.close());
  replies.answer(ANSWER);
  replies.presence('phone', 'hidden');
  replies.presence('phone', 'gone');
  replies.answer(ANSWER);
  await wait(80);
  assert.equal(told.length, 0);
});

test('coming back cancels what the log was about to say', async (t) => {
  const { replies, told } = notifier();
  t.after(() => replies.close());
  replies.presence('phone', 'hidden');
  replies.answer(ANSWER);
  replies.presence('phone', 'visible');
  await wait(80);
  assert.equal(told.length, 0);
});

test('the usage log is read from where it ended when the reader left', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-replies-'));
  const file = join(root, 'usage-events.jsonl');
  // Answered while they were looking: they saw it.
  await writeFile(file, `${JSON.stringify(ANSWER)}\n`);
  const { replies, told } = notifier(file, { pollMs: 10 });
  t.after(() => replies.close());
  replies.presence('phone', 'hidden');
  await wait(60);
  assert.equal(told.length, 0);
  // Half a line, then the rest of it, as an append still going on looks.
  const line = JSON.stringify({ ...ANSWER, cut: true });
  await appendFile(file, line.slice(0, 20));
  await wait(40);
  await appendFile(file, `${line.slice(20)}\n`);
  await wait(120);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.en.body, 'The reply stopped before it finished. Open SillyTavern to see what arrived.');
});

test('a page report is taken only in the shape of one, and only so large', () => {
  assert.equal(parseReplyReport(null), null);
  assert.equal(parseReplyReport({ ...REPORT, key: 'x:1' }), null, 'a conversation is a character or a group');
  assert.equal(parseReplyReport({ ...REPORT, title: '' }), null);
  const taken = parseReplyReport({ ...REPORT, text: 'b'.repeat(5000), extra: 'ignored' });
  assert.equal(taken?.text.length, 1000);
  assert.equal('extra' in (taken ?? {}), false);
});
