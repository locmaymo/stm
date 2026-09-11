import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import type { UsageEvent } from '../../../packages/contracts/src/index.js';
import { MetricsStore } from '../src/metrics.js';

test('metrics store ignores malformed and unknown JSONL records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-metrics-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new MetricsStore(paths);
  const event: UsageEvent = {
    schemaVersion: 1, timestamp: '2026-09-11T10:00:00.000Z', provider: 'openai', model: 'gpt-test', endpointHost: 'api.openai.com',
    stream: false, maxTokens: 100, inputTokens: 4, outputTokens: 6, totalTokens: 10, status: 200, durationMs: 12,
  };
  await store.append(event);
  await mkdir(paths.metrics, { recursive: true });
  await appendFile(store.filePath, '{"schemaVersion":1,"provider":"unknown"}\nnot-json\n', 'utf8');
  const snapshot = await store.snapshot(new Date('2026-09-11T12:00:00.000Z'));
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.totalTokens, 10);
});
