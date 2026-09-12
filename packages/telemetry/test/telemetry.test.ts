import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageEvent } from '../../contracts/src/index.js';
import { getPlatformPaths } from '../../platform/src/index.js';
import { TelemetryTransport } from '../src/index.js';

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    schemaVersion: 1, timestamp: '2026-09-12T00:00:00.000Z', provider: 'proxyvn.top', completionSource: 'google', model: 'chatgpt-4o-latest', endpointHost: 'proxyvn.top', stream: true, maxTokens: 512, inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 3, status: 200, durationMs: 25, ...overrides,
  };
}

test('telemetry writes an allowlisted batch and removes secrets from serialized output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-telemetry-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const metrics = join(paths.metrics, 'usage-events.jsonl');
  await mkdir(paths.metrics, { recursive: true });
  await appendFile(metrics, `${JSON.stringify({ ...event(), apiKey: 'secret-key', prompt: 'private chat', endpointHost: 'proxyvn.top/path?token=bad' })}\n`, 'utf8');
  const transport = new TelemetryTransport({ paths, metricsFile: metrics, installId: 'install-1', platform: 'linux', endpoint: '' });
  await transport.start();
  await transport.flushNow();
  const outbox = await readFile(transport.outboxPath, 'utf8');
  assert.equal(outbox.includes('secret-key'), false);
  assert.equal(outbox.includes('private chat'), false);
  assert.equal(outbox.includes('proxyvn.top/path'), false);
  const batch = JSON.parse(outbox.trim()) as { events: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(batch.events[0] ?? {}).sort(), ['cacheReadTokens', 'cacheWriteTokens', 'completionSource', 'durationMs', 'endpointHost', 'inputTokens', 'maxTokens', 'model', 'outputTokens', 'provider', 'reasoningTokens', 'schemaVersion', 'status', 'stream', 'timestamp', 'totalTokens']);
  assert.equal(batch.events[0]?.endpointHost, null);
  await transport.close();
});

test('telemetry keeps failed deliveries queued and retries later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-telemetry-retry-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const metrics = join(paths.metrics, 'usage-events.jsonl');
  await mkdir(paths.metrics, { recursive: true });
  await appendFile(metrics, `${JSON.stringify(event())}\n`, 'utf8');
  let attempts = 0;
  let enrollments = 0;
  let envelopeBody = '';
  const signingKey = Buffer.alloc(32, 7).toString('base64url');
  const transport = new TelemetryTransport({ paths, metricsFile: metrics, installId: 'install-2', platform: 'linux', endpoint: 'https://telemetry.example.test/v1/telemetry', fetch: async (input, init) => {
    if (String(input).endsWith('/v1/enroll')) {
      enrollments += 1;
      return new Response(JSON.stringify({ key: signingKey }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    attempts += 1;
    envelopeBody = String(init?.body ?? '');
    return new Response(null, { status: attempts < 3 ? 503 : 204 });
  } });
  await transport.start();
  await transport.flushNow();
  assert.notEqual((await readFile(transport.outboxPath, 'utf8')).trim(), '');
  await transport.flushNow();
  assert.equal((await readFile(transport.outboxPath, 'utf8')).trim(), '');
  assert.equal(attempts, 3);
  assert.equal(enrollments, 1);
  const envelope = JSON.parse(envelopeBody) as { schemaVersion: 1; installId: string; sentAt: string; nonce: string; signature?: string; batch?: { installId?: string } };
  assert.equal(envelope.batch?.installId, 'install-2');
  assert.match(envelope.signature ?? '', /^[A-Za-z0-9_-]{43}$/u);
  const unsigned = { schemaVersion: envelope.schemaVersion, installId: envelope.installId, sentAt: envelope.sentAt, nonce: envelope.nonce, batch: envelope.batch };
  assert.equal(envelope.signature, createHmac('sha256', Buffer.from(signingKey, 'base64url')).update(JSON.stringify(unsigned), 'utf8').digest('base64url'));
  await transport.close();
});

test('telemetry cursor resumes an incomplete JSONL append without duplicating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-telemetry-partial-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const metrics = join(paths.metrics, 'usage-events.jsonl');
  await mkdir(paths.metrics, { recursive: true });
  const serialized = JSON.stringify(event());
  await appendFile(metrics, serialized.slice(0, 20), 'utf8');
  const transport = new TelemetryTransport({ paths, metricsFile: metrics, installId: 'install-3', platform: 'linux', endpoint: '' });
  await transport.start();
  await appendFile(metrics, `${serialized.slice(20)}\n`, 'utf8');
  await transport.pollNow();
  await transport.flushNow();
  const outbox = (await readFile(transport.outboxPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(outbox.length, 1);
  await transport.close();
});
