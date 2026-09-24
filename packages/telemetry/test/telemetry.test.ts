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

test('how long the manager was used travels with the events, and alone when there are none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-telemetry-usage-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const metrics = join(paths.metrics, 'usage-events.jsonl');
  const usage = join(paths.metrics, 'app-usage.jsonl');
  await mkdir(paths.metrics, { recursive: true });
  await appendFile(usage, `${JSON.stringify({ schemaVersion: 1, date: '2026-09-19', managerSeconds: 3600, sillyTavernSeconds: 1800, consoleSeconds: 240, starts: 2 })}\n`, 'utf8');

  // A manager nobody has pointed at a provider still has something to say:
  // that it was installed, started, and left running.
  const transport = new TelemetryTransport({ paths, metricsFile: metrics, usageFile: usage, installId: 'install-4', platform: 'linux', endpoint: '' });
  await transport.start();
  await transport.flushNow();
  const first = (await readFile(transport.outboxPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(first.length, 1);
  const alone = JSON.parse(first[0] ?? '{}') as { events: unknown[]; usageDays?: Array<{ date: string; consoleSeconds: number }> };
  assert.deepEqual(alone.events, []);
  assert.equal(alone.usageDays?.[0]?.date, '2026-09-19');
  assert.equal(alone.usageDays?.[0]?.consoleSeconds, 240);

  // A day already sent is not sent again, and a batch with only provider
  // events carries no usage field at all.
  await appendFile(metrics, `${JSON.stringify(event())}\n`, 'utf8');
  await transport.pollNow();
  await transport.flushNow();
  const lines = (await readFile(transport.outboxPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
  const latest = JSON.parse(lines.at(-1) ?? '{}') as { events: unknown[]; usageDays?: unknown };
  assert.equal(latest.events.length, 1);
  assert.equal('usageDays' in latest, false);
  await transport.close();
});

/**
 * A started transport that has enrolled once with nothing to send, and then
 * queued one batch for a receiver that answers with `refusal`.
 */
async function refusedTransport(installId: string, refusal: () => Response) {
  const root = await mkdtemp(join(tmpdir(), 'stm-telemetry-refused-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const metrics = join(paths.metrics, 'usage-events.jsonl');
  await mkdir(paths.metrics, { recursive: true });
  const keys = [Buffer.alloc(32, 1).toString('base64url'), Buffer.alloc(32, 2).toString('base64url')];
  const state = { enrollments: 0, refuse: true, envelopes: [] as string[] };
  const transport = new TelemetryTransport({ paths, metricsFile: metrics, installId, platform: 'linux', endpoint: 'https://telemetry.example.invalid/v1/telemetry', fetch: async (input, init) => {
    if (String(input).endsWith('/v1/enroll')) {
      const key = keys[state.enrollments] ?? keys[1];
      state.enrollments += 1;
      return new Response(JSON.stringify({ key }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    state.envelopes.push(String(init?.body ?? ''));
    return state.refuse ? refusal() : new Response(null, { status: 204 });
  } });
  await transport.start();
  await transport.flushNow();
  await appendFile(metrics, `${JSON.stringify(event())}\n`, 'utf8');
  await transport.pollNow();
  return { transport, state, keys, identity: join(paths.outbox, 'telemetry-identity.json') };
}

function jsonRefusal(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
}

function signedWith(key: string | undefined, body: string | undefined): boolean {
  const { signature, ...unsigned } = JSON.parse(body ?? '{}') as { signature?: string };
  return signature === createHmac('sha256', Buffer.from(key ?? '', 'base64url')).update(JSON.stringify(unsigned), 'utf8').digest('base64url');
}

test('an installation the receiver has forgotten drops its key and enrolls again, keeping the batch', async () => {
  const { transport, state, keys, identity } = await refusedTransport('install-5', () => jsonRefusal(401, 'unknown_installation'));
  await transport.flushNow();
  assert.equal(state.enrollments, 1);
  assert.equal(state.envelopes.length, 1);
  assert.ok(signedWith(keys[0], state.envelopes[0]));
  await assert.rejects(readFile(identity, 'utf8'), { code: 'ENOENT' });
  assert.notEqual((await readFile(transport.outboxPath, 'utf8')).trim(), '');

  state.refuse = false;
  await transport.flushNow();
  assert.equal(state.enrollments, 2);
  assert.equal((await readFile(transport.outboxPath, 'utf8')).trim(), '');
  assert.equal((JSON.parse(await readFile(identity, 'utf8')) as { key: string }).key, keys[1]);
  assert.equal(state.envelopes.length, 2);
  assert.ok(signedWith(keys[1], state.envelopes[1]));
  await transport.close();
});

for (const [label, refusal] of [
  ['401 invalid_signature', () => jsonRefusal(401, 'invalid_signature')],
  ['401 without a JSON body', () => new Response('unauthorized', { status: 401 })],
  ['403 unknown_installation', () => jsonRefusal(403, 'unknown_installation')],
  ['500 unknown_installation', () => jsonRefusal(500, 'unknown_installation')],
  ['503', () => new Response(null, { status: 503 })],
] as const) {
  test(`a ${label} refusal keeps the key and the batch and does not enroll again`, async () => {
    const { transport, state, keys, identity } = await refusedTransport(`install-${label.replace(/\W+/gu, '-')}`, refusal);
    await transport.flushNow();
    await transport.flushNow();
    assert.equal(state.enrollments, 1);
    assert.equal(state.envelopes.length, 2);
    assert.ok(state.envelopes.every((body) => signedWith(keys[0], body)));
    assert.equal((JSON.parse(await readFile(identity, 'utf8')) as { key: string }).key, keys[0]);
    assert.notEqual((await readFile(transport.outboxPath, 'utf8')).trim(), '');
    await transport.close();
  });
}
