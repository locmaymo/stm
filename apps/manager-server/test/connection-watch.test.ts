import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionTestResult } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { BURST_MIN, ConnectionWatcher, ConnectionWatchStore, DAILY_MS, DEFAULT_WATCH_SETTINGS, errorBursts, MetricsTail, parseWatchSettings, watchFindings, type TestedTarget, type WatchFinding } from '../src/connection-watch.js';

const result = (code: ConnectionTestResult['code'], balance: ConnectionTestResult['balance'] = null): ConnectionTestResult => ({ code, via: 'direct', provider: 'openrouter', httpStatus: 200, latencyMs: 10, modelCount: 1, balance, sent: false, testedAt: '2026-10-13T00:00:00.000Z' });
const key = { kind: 'key', secretKey: 'api_key_openrouter', id: 'k1' } as const;
const tested = (previous: ConnectionTestResult | null, next: ConnectionTestResult, target: TestedTarget['target'] = key): TestedTarget => ({ target, name: 'chính (OpenRouter)', previous, result: next });
const kinds = (findings: readonly WatchFinding[]) => findings.map((finding) => finding.kind);

test('the bell hears about a key when it gets worse, not every day it stays bad', () => {
  assert.deepEqual(kinds(watchFindings(tested(result('ok'), result('invalid_key')), null)), ['connectionKeyInvalid']);
  assert.deepEqual(kinds(watchFindings(tested(null, result('invalid_key')), null)), ['connectionKeyInvalid']);
  assert.deepEqual(kinds(watchFindings(tested(result('invalid_key'), result('invalid_key')), null)), []);
  assert.deepEqual(kinds(watchFindings(tested(result('ok'), result('no_credit')), null)), ['connectionNoCredit']);
  assert.deepEqual(kinds(watchFindings(tested(result('no_credit'), result('no_credit')), null)), []);
  assert.deepEqual(kinds(watchFindings(tested(result('ok'), result('rate_limited')), null)), [], 'a busy minute is not news');
  assert.deepEqual(kinds(watchFindings(tested(result('ok'), result('unreachable')), null)), [], 'a network blip on a key is not a dead key');
  const invalid = watchFindings(tested(result('ok'), result('invalid_key')), null)[0];
  assert.deepEqual(invalid?.params, { name: 'chính (OpenRouter)' });
  assert.equal(invalid?.dedupeKey, 'connectionKeyInvalid:api_key_openrouter:k1');
});

test('credit below the line is told once, when it crosses it', () => {
  const usd = (amount: number) => ({ amount, currency: 'USD' });
  assert.deepEqual(kinds(watchFindings(tested(result('ok', usd(5)), result('ok', usd(0.12))), 1)), ['connectionLowCredit']);
  assert.deepEqual(watchFindings(tested(result('ok', usd(5)), result('ok', usd(0.12))), 1)[0]?.params, { name: 'chính (OpenRouter)', amount: '$0.12', threshold: '$1.00' });
  assert.deepEqual(kinds(watchFindings(tested(null, result('ok', usd(0.12))), 1)), ['connectionLowCredit']);
  assert.deepEqual(kinds(watchFindings(tested(result('ok', usd(0.5)), result('ok', usd(0.12))), 1)), [], 'already below last time');
  assert.deepEqual(kinds(watchFindings(tested(result('ok', usd(5)), result('ok', usd(2))), 1)), []);
  assert.deepEqual(kinds(watchFindings(tested(result('ok', usd(5)), result('ok', usd(0.12))), null)), [], 'no line set');
  assert.equal(watchFindings(tested(null, result('ok', { amount: 3, currency: 'CNY' })), 5)[0]?.params.amount, 'CN¥3.00');
});

test('a proxy that stops answering is told; one that never worked is not news', () => {
  const proxy = { kind: 'proxy', name: 'Proxy nhà' } as const;
  const down = watchFindings(tested(result('ok'), result('unreachable'), proxy), null);
  assert.deepEqual(kinds(down), ['connectionProxyDown']);
  assert.deepEqual(down[0]?.params, { name: 'chính (OpenRouter)', problem: 'unreachable' });
  assert.deepEqual(kinds(watchFindings(tested(result('ok'), result('proxy_auth'), proxy), null)), ['connectionProxyDown']);
  assert.deepEqual(kinds(watchFindings(tested(result('unreachable'), result('unreachable'), proxy), null)), []);
  assert.deepEqual(kinds(watchFindings(tested(null, result('unreachable'), proxy), null)), []);
});

test('a run of refusals from one provider in ten minutes is a hint; a few, or old ones, are not', () => {
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  const refusals = [
    ...Array.from({ length: BURST_MIN }, (_, index) => ({ at: now - index * 60_000, provider: 'openrouter.ai', status: 401 })),
    ...Array.from({ length: BURST_MIN - 1 }, () => ({ at: now - 1_000, provider: 'openrouter.ai', status: 429 })),
    ...Array.from({ length: BURST_MIN }, () => ({ at: now - 11 * 60_000, provider: 'anthropic', status: 429 })),
    ...Array.from({ length: BURST_MIN }, () => ({ at: now - 1_000, provider: 'google', status: 429 })),
  ];
  const bursts = errorBursts(refusals, now);
  assert.deepEqual(bursts.map((finding) => [finding.kind, finding.params.provider, finding.params.count]), [['connectionRefused', 'OpenRouter', BURST_MIN], ['connectionRateLimited', 'Google', BURST_MIN]]);
  assert.equal(bursts[0]?.dedupeKey, 'connectionBurst:openrouter.ai:auth');
});

test('the metrics file is followed as it grows, refusals only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-watch-tail-'));
  const file = join(root, 'usage-events.jsonl');
  const line = (status: number, at: string, provider = 'openrouter.ai') => `${JSON.stringify({ schemaVersion: 1, timestamp: at, provider, model: 'm', endpointHost: provider, stream: false, maxTokens: null, inputTokens: null, outputTokens: null, totalTokens: null, status, durationMs: 5 })}\n`;
  const tail = new MetricsTail(file);
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  assert.deepEqual(await tail.read(now), [], 'no file yet');
  await writeFile(file, line(200, '2026-10-13T11:59:00.000Z') + line(401, '2026-10-13T11:59:00.000Z'));
  assert.deepEqual((await tail.read(now)).map((refusal) => refusal.status), [401]);
  // A line still being written is read once it ends.
  await appendFile(file, line(429, '2026-10-13T11:59:30.000Z').slice(0, 40));
  assert.equal((await tail.read(now)).length, 1);
  await appendFile(file, line(429, '2026-10-13T11:59:30.000Z').slice(40));
  assert.deepEqual((await tail.read(now)).map((refusal) => refusal.status), [401, 429]);
  // Ten minutes on, both have left the window.
  assert.deepEqual(await tail.read(now + 11 * 60_000), []);
  // A file that was rewritten shorter is read again from its start.
  await writeFile(file, line(403, '2026-10-13T12:10:00.000Z'));
  assert.deepEqual((await tail.read(now + 11 * 60_000)).map((refusal) => refusal.status), [403]);
});

test('the daily test runs a day after the last one, only when turned on, and says what got worse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-watch-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ConnectionWatchStore(paths);
  let now = Date.parse('2026-10-13T08:00:00.000Z');
  let runs = 0;
  const told: WatchFinding[] = [];
  const watcher = new ConnectionWatcher({
    store,
    tail: new MetricsTail(join(root, 'none.jsonl')),
    now: () => now,
    tickMs: 3_600_000,
    notify: async (finding) => { told.push(finding); },
    testAll: async () => { runs += 1; return [tested(result('ok'), result('invalid_key'))]; },
  });
  try {
    await watcher.tick();
    assert.equal(runs, 0, 'off until turned on');
    await store.update({ daily: true });
    await watcher.tick();
    assert.equal(runs, 1);
    assert.deepEqual(kinds(told), ['connectionKeyInvalid']);
    assert.equal((await store.get()).lastRunAt, '2026-10-13T08:00:00.000Z');
    now += DAILY_MS - 1;
    await watcher.tick();
    assert.equal(runs, 1, 'not yet a day');
    now += 1;
    await watcher.tick();
    assert.equal(runs, 2);
    // The settings outlive the manager.
    assert.deepEqual(await new ConnectionWatchStore(paths).get(), { daily: true, creditThreshold: null, errorHints: true, lastRunAt: new Date(now).toISOString() });
  } finally {
    watcher.close();
  }
});

test('settings are read leniently from a file and strictly from nothing', () => {
  assert.deepEqual(parseWatchSettings({}), DEFAULT_WATCH_SETTINGS);
  assert.deepEqual(parseWatchSettings({ daily: true, creditThreshold: 2.5, errorHints: false, lastRunAt: 'not a date' }), { daily: true, creditThreshold: 2.5, errorHints: false, lastRunAt: null });
  assert.equal(parseWatchSettings({ creditThreshold: -1 })?.creditThreshold, null);
  assert.equal(parseWatchSettings(null), null);
});
