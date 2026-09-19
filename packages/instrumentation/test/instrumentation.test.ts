import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { aggregateUsageEvents, instrumentationLoaderPath, type UsageEvent } from '../src/index.js';

test('fetch loader records only allowlisted metadata for JSON and streaming responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-instrumentation-'));
  const eventsPath = join(root, 'metrics', 'usage-events.jsonl');
  const server = createServer((request, response) => {
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"model":"ignored","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n');
      return;
    }
    if (request.url === '/v1beta/models/chatgpt-4o-latest:generateContent') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 9, totalTokenCount: 16, cachedContentTokenCount: 3 }, reasoningTokenCount: 4 }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, secret: 'must not persist' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const script = `
    const nodeFetch = (await import('node-fetch')).default;
    const body = JSON.stringify({ model: 'gpt-test', max_tokens: 128, stream: false, prompt: 'never persist' });
    await (await fetch(${JSON.stringify(`${base}/json`)}, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret-key' }, body })).text();
    const stream = await nodeFetch(${JSON.stringify(`${base}/stream`)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-test', stream: true, messages: [{ content: 'private chat' }] }) });
    await stream.text();
    const google = await nodeFetch(${JSON.stringify(`${base}/v1beta/models/chatgpt-4o-latest:generateContent`)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generationConfig: { maxOutputTokens: 512 }, contents: [{ parts: [{ text: 'private chat' }] }] }) });
    await google.json();
  `;
  await runNode(['--import', instrumentationLoaderPath, '--input-type=module', '-e', script], { STM_METRICS_FILE: eventsPath });
  server.close();
  const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.length, 3);
  assert.deepEqual(Object.keys(events[0] ?? {}).sort(), ['cacheReadTokens', 'cacheWriteTokens', 'completionSource', 'durationMs', 'endpointHost', 'inputTokens', 'maxTokens', 'model', 'outputTokens', 'provider', 'reasoningTokens', 'schemaVersion', 'status', 'stream', 'timestamp', 'totalTokens']);
  assert.equal(events[0]?.model, 'gpt-test');
  assert.equal(events[0]?.maxTokens, 128);
  assert.equal(events[0]?.inputTokens, 11);
  assert.equal(events[0]?.outputTokens, 7);
  assert.equal(events[1]?.stream, true);
  assert.equal(events[1]?.inputTokens, 2);
  assert.equal(events[1]?.outputTokens, 3);
  assert.equal(events[2]?.provider, 'unknown');
  assert.equal(events[2]?.completionSource, 'google');
  assert.equal(events[2]?.model, 'chatgpt-4o-latest');
  assert.equal(events[2]?.maxTokens, 512);
  assert.equal(events[2]?.stream, false);
  assert.equal(events[2]?.inputTokens, 7);
  assert.equal(events[2]?.outputTokens, 9);
  assert.equal(events[2]?.cacheReadTokens, 3);
  assert.equal(events[2]?.reasoningTokens, 4);
  assert.equal(JSON.stringify(events).includes('secret-key'), false);
  assert.equal(JSON.stringify(events).includes('private chat'), false);
  assert.equal(JSON.stringify(events).includes('must not persist'), false);
});

test('requests that are not model calls are left out of the usage log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-instrumentation-noise-'));
  const eventsPath = join(root, 'metrics', 'usage-events.jsonl');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/proxy/custom-path') {
      response.end(JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }));
      return;
    }
    response.end(JSON.stringify({ name: 'extension', version: '1.0.0', usage: 'not a token count' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const script = `
    // An extension manifest, a model list, and a plugin call with no usage in its answer.
    await (await fetch(${JSON.stringify(`${base}/SillyTavern/Extension/main/manifest.json`)})).text();
    await (await fetch(${JSON.stringify(`${base}/v1/models`)})).text();
    await (await fetch(${JSON.stringify(`${base}/api/plugins/update`)}, { method: 'POST', body: '{}' })).text();
    // A proxy serving a completion from a path nobody could guess still counts.
    await (await fetch(${JSON.stringify(`${base}/proxy/custom-path`)}, { method: 'POST', body: JSON.stringify({ model: 'proxied' }) })).text();
    // A known completion route counts even when the answer carries no usage.
    await (await fetch(${JSON.stringify(`${base}/v1/chat/completions`)}, { method: 'POST', body: JSON.stringify({ model: 'quiet' }) })).text();
  `;
  await runNode(['--import', instrumentationLoaderPath, '--input-type=module', '-e', script], { STM_METRICS_FILE: eventsPath });
  server.close();
  const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map((event) => event.model), ['proxied', 'quiet']);
});

test('usage logged before the observer knew better leaves out downloads it recorded', () => {
  const now = new Date('2026-09-11T12:00:00.000Z');
  const download: UsageEvent = { schemaVersion: 1, timestamp: now.toISOString(), provider: 'raw.githubusercontent.com', completionSource: null, model: null, endpointHost: 'raw.githubusercontent.com', stream: false, maxTokens: null, inputTokens: null, outputTokens: null, totalTokens: null, status: 200, durationMs: 80 };
  const reply: UsageEvent = { ...download, provider: 'openai', completionSource: 'openai', model: 'gpt-test', endpointHost: 'api.openai.com', inputTokens: 3, outputTokens: 2, totalTokens: 5 };
  const snapshot = aggregateUsageEvents([download, download, reply], now, 30);
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.models.some((bucket) => bucket.key === 'unknown'), false);
});

test('CJS node-fetch is wrapped for legacy SillyTavern runtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-instrumentation-cjs-'));
  const eventsPath = join(root, 'metrics', 'usage-events.jsonl');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  const v2Path = join(process.cwd(), 'node_modules', 'node-fetch-v2');
  await symlink(v2Path, join(root, 'node_modules', 'node-fetch'), 'junction');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const script = `(async () => {
    const { createRequire } = await import('node:module');
    const fetch = createRequire(${JSON.stringify(join(root, 'main.cjs'))})('node-fetch');
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}/chat`)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'legacy-model', stream: false }) });
    await response.json();
  })();`;
  await runNode(['--import', instrumentationLoaderPath, '--input-type=module', '-e', script], { STM_METRICS_FILE: eventsPath });
  server.close();
  const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.model, 'legacy-model');
  assert.equal(events[0]?.inputTokens, 5);
  assert.equal(events[0]?.outputTokens, 2);
});

test('metrics aggregation groups requests by day, provider, and model', () => {
  const now = new Date('2026-09-11T12:00:00.000Z');
  const event = (overrides: Partial<UsageEvent>): UsageEvent => ({
    schemaVersion: 1, timestamp: now.toISOString(), provider: 'openai', model: 'gpt-test', endpointHost: 'api.openai.com',
    stream: false, maxTokens: null, inputTokens: 2, outputTokens: 3, totalTokens: 5, status: 200, durationMs: 20, ...overrides,
  });
  const snapshot = aggregateUsageEvents([event({}), event({ status: 500, durationMs: 40 }), event({ provider: 'anthropic', model: 'claude-test', timestamp: '2026-09-10T12:00:00.000Z', inputTokens: null, outputTokens: null, totalTokens: null }), event({ provider: 'google', endpointHost: 'proxyvn.top', completionSource: 'google', model: 'chatgpt-4o-latest', inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 0 })], now, 30);
  assert.equal(snapshot.totals.requests, 4);
  assert.equal(snapshot.totals.errors, 1);
  assert.equal(snapshot.totals.totalTokens, 22);
  assert.equal(snapshot.totals.averageLatencyMs, 25);
  assert.equal(snapshot.providers[0]?.key, 'openai');
  assert.equal(snapshot.models.some((bucket) => bucket.key === 'claude-test'), true);
  assert.equal(snapshot.daily.length, 2);
  assert.equal(snapshot.providers.some((bucket) => bucket.key === 'proxyvn.top'), true);
  assert.equal(snapshot.providers.some((bucket) => bucket.key === 'google'), false);
  assert.equal(snapshot.totals.cacheHitRate, 0.4);
});

test('cache hit rate is unknown when no cache metadata is observed', () => {
  const now = new Date('2026-09-11T12:00:00.000Z');
  const event: UsageEvent = { schemaVersion: 1, timestamp: now.toISOString(), provider: 'proxyvn.top', completionSource: 'google', model: 'test', endpointHost: 'proxyvn.top', stream: false, maxTokens: null, inputTokens: 10, outputTokens: 1, totalTokens: 11, status: 200, durationMs: 1 };
  assert.equal(aggregateUsageEvents([event], now, 30).totals.cacheHitRate, null);
});

test('cache hit denominator includes Anthropic cache read and write tokens', () => {
  const now = new Date('2026-09-11T12:00:00.000Z');
  const event: UsageEvent = { schemaVersion: 1, timestamp: now.toISOString(), provider: 'api.anthropic.com', completionSource: 'anthropic', model: 'claude-test', endpointHost: 'api.anthropic.com', stream: false, maxTokens: null, inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 3, status: 200, durationMs: 1 };
  const snapshot = aggregateUsageEvents([{ ...event, totalTokens: null }], now, 30);
  assert.equal(snapshot.totals.cacheHitRate, 0.2);
  assert.equal(snapshot.totals.totalTokens, 11);
});

test('every way into the observer writes the usage log through one queue', async () => {
  /*
   * There are three: the global `fetch`, the CJS bridge for older SillyTavern
   * releases, and the ESM hook that rewrites node-fetch. The third reads its
   * options off `globalThis`, and nothing ever put them there - so it quietly
   * made a second write queue of its own, and two queues appending to one file
   * have no order between them. A call that had already finished could be
   * written after one that came later, which is why the test above failed on
   * Windows about once in a while.
   */
  const root = await mkdtemp(join(tmpdir(), 'stm-instrumentation-queue-'));
  const seen = join(root, 'seen.json');
  const script = `
    const { writeFileSync } = await import('node:fs');
    writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ persist: typeof globalThis.__stmInstrumentationOptions?.persist }));
  `;
  await runNode(['--import', instrumentationLoaderPath, '--input-type=module', '-e', script], { STM_METRICS_FILE: join(root, 'metrics', 'usage-events.jsonl') });

  assert.deepEqual(JSON.parse(await readFile(seen, 'utf8')), { persist: 'function' });
});

async function runNode(args: string[], env: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
}
