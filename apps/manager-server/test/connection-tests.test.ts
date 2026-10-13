import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionTarget } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { parseSecrets, parseSettings } from '../src/connections.js';
import { CHAT_STATUS_PATH, classify, ConnectionTargetMissing, ConnectionTester, ConnectionTestStore, ModelCache, parseModels, TEXT_STATUS_PATH, type SillyTavernStatusCall } from '../src/connection-tests.js';

/**
 * Fake providers, one per path prefix, each answering the way the real one
 * does as far as a test can tell: the models list, the key and balance pages,
 * and the errors each uses for a wrong key, no credit and too many requests.
 *
 * Keys say what they are: `good-*` works, `bad-*` is refused, `broke-*` has no
 * credit, `busy-*` is rate limited, `limit-*` is an OpenRouter key at its cap.
 */
interface Fake {
  readonly url: string;
  /** Every request, as `METHOD path`, and each POST body. */
  readonly seen: string[];
  readonly bodies: unknown[];
  readonly headers: Array<Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
}

async function fakeProviders(): Promise<Fake> {
  const seen: string[] = [];
  const bodies: unknown[] = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { raw += chunk; });
    request.on('end', () => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      seen.push(`${request.method} ${path}`);
      headers.push(request.headers);
      if (raw) bodies.push(JSON.parse(raw) as unknown);
      const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1] ?? '';
      const kind = (key: string) => key.split('-')[0];
      // OpenAI and everything shaped like it.
      const openAiLike = (key: string, models: unknown[]) => {
        const what = kind(key);
        if (what === 'bad') return json(response, 401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
        if (what === 'broke') return json(response, 429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } });
        if (what === 'busy') return json(response, 429, { error: { message: 'Rate limit reached for requests' } });
        if (request.method === 'POST') return json(response, 200, { choices: [{ message: { content: 'H' } }] });
        return json(response, 200, { object: 'list', data: models });
      };
      if (path.startsWith('/openai/v1/')) return openAiLike(bearer, [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }]);
      if (path.startsWith('/mistral/v1/')) return openAiLike(bearer, [{ id: 'mistral-large-latest' }]);
      if (path.startsWith('/groq/v1/')) return openAiLike(bearer, [{ id: 'llama-3.3-70b' }]);
      if (path.startsWith('/xai/v1/')) return openAiLike(bearer, [{ id: 'grok-4' }]);
      if (path.startsWith('/custom/v1/')) return openAiLike(bearer || 'good', [{ id: 'local-model' }]);
      if (path === '/html/models') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Not an API</title>'); return; }
      if (path.startsWith('/proxy/v1/')) {
        if (bearer !== 'proxy-pass') return json(response, 401, { error: 'Unauthorized' });
        return json(response, 200, { data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet-4' }, { id: 'gemini-2.5-pro' }] });
      }
      if (path.startsWith('/openrouter/api/v1/')) {
        const rest = path.slice('/openrouter/api/v1'.length);
        if (rest === '/models') return json(response, 200, { data: [{ id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', context_length: 64000, pricing: { prompt: '0.00000014', completion: '0.00000028' } }] });
        if (kind(bearer) === 'bad') return json(response, 401, { error: { message: 'No auth credentials found', code: 401 } });
        if (rest === '/key') {
          return json(response, 200, { data: kind(bearer) === 'limit' ? { limit: 5, limit_remaining: 0, usage: 5, is_free_tier: false } : { limit: null, limit_remaining: null, usage: 1, is_free_tier: kind(bearer) === 'free' } });
        }
        if (rest === '/credits') return json(response, 200, { data: kind(bearer) === 'free' ? { total_credits: 0, total_usage: 0 } : { total_credits: 10, total_usage: 9.88 } });
        return json(response, 404, {});
      }
      if (path.startsWith('/claude/v1/')) {
        const key = String(request.headers['x-api-key'] ?? '');
        if (request.headers['anthropic-version'] !== '2023-06-01') return json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version header is required' } });
        if (kind(key) !== 'good') return json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        if (request.method === 'POST') return json(response, 200, { content: [{ type: 'text', text: 'H' }] });
        return json(response, 200, { data: [{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', type: 'model' }], has_more: false });
      }
      if (path.startsWith('/google/v1beta/models')) {
        const key = String(request.headers['x-goog-api-key'] ?? '');
        if (kind(key) !== 'good') return json(response, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
        if (request.method === 'POST') return json(response, 200, { candidates: [] });
        return json(response, 200, { models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576 }] });
      }
      if (path.startsWith('/deepseek/')) {
        if (kind(bearer) === 'bad') return json(response, 401, { error: { message: 'Authentication Fails', type: 'authentication_error' } });
        if (path === '/deepseek/models') return json(response, 200, { object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
        if (path === '/deepseek/user/balance') return json(response, 200, kind(bearer) === 'broke' ? { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] } : { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] });
      }
      if (path.startsWith('/cohere/v1/')) {
        if (kind(bearer) !== 'good') return json(response, 401, { message: 'invalid api token' });
        return json(response, 200, { models: [{ name: 'command-r-plus', context_length: 128000 }] });
      }
      json(response, 404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, bodies, headers, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function bases(url: string): Record<string, string> {
  return {
    openrouter: `${url}/openrouter/api/v1`,
    openai: `${url}/openai/v1`,
    claude: `${url}/claude/v1`,
    makersuite: `${url}/google`,
    deepseek: `${url}/deepseek`,
    mistralai: `${url}/mistral/v1`,
    cohere: `${url}/cohere/v1`,
    groq: `${url}/groq/v1`,
    xai: `${url}/xai/v1`,
  };
}

/** One key per name, as `secrets.json` would hold it. */
function secrets(keys: Record<string, string[]>) {
  return parseSecrets(Object.fromEntries(Object.entries(keys).map(([name, values]) => [name, values.map((value, index) => ({ id: `${name}-${index}`, value, label: `${name} ${index}`, active: index === 0 }))])));
}

const key = (secretKey: string, index = 0): ConnectionTarget => ({ kind: 'key', secretKey, id: `${secretKey}-${index}` });

test('every provider in the table is asked directly, and each kind of refusal is told apart', async (t) => {
  const fake = await fakeProviders();
  t.after(() => fake.close());
  const tester = new ConnectionTester({ bases: bases(fake.url) });
  const stored = secrets({
    api_key_openai: ['good-openai-0000000000', 'bad-openai-00000000000', 'broke-openai-000000000', 'busy-openai-0000000000'],
    api_key_claude: ['good-claude', 'bad-claude'],
    api_key_makersuite: ['good-google', 'bad-google'],
    api_key_deepseek: ['good-deepseek', 'broke-deepseek', 'bad-deepseek'],
    api_key_mistralai: ['good-mistral', 'busy-mistral'],
    api_key_cohere: ['good-cohere', 'bad-cohere'],
    api_key_groq: ['good-groq'],
    api_key_xai: ['bad-xai'],
  });
  const settings = parseSettings({});
  const run = async (target: ConnectionTarget) => (await tester.test(target, stored, settings)).result;
  const summary = async (target: ConnectionTarget) => {
    const result = await run(target);
    return [result.code, result.modelCount, result.balance, result.via];
  };
  assert.deepEqual(await summary(key('api_key_openai', 0)), ['ok', 2, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_openai', 1)), ['invalid_key', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_openai', 2)), ['no_credit', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_openai', 3)), ['rate_limited', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_claude', 0)), ['ok', 1, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_claude', 1)), ['invalid_key', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_makersuite', 0)), ['ok', 1, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_makersuite', 1)), ['invalid_key', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_deepseek', 0)), ['ok', 2, { amount: 12.5, currency: 'CNY' }, 'direct']);
  assert.deepEqual(await summary(key('api_key_deepseek', 1)), ['no_credit', 2, { amount: 0, currency: 'CNY' }, 'direct']);
  assert.deepEqual(await summary(key('api_key_deepseek', 2)), ['invalid_key', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_mistralai', 0)), ['ok', 1, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_mistralai', 1)), ['rate_limited', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_cohere', 0)), ['ok', 1, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_cohere', 1)), ['invalid_key', null, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_groq', 0)), ['ok', 1, null, 'direct']);
  assert.deepEqual(await summary(key('api_key_xai', 0)), ['invalid_key', null, null, 'direct']);
  // Google's key goes in a header, never in the address, where logs keep it.
  assert.equal(fake.seen.some((line) => line.includes('good-google')), false);
  assert.ok(fake.headers.some((item) => item['x-goog-api-key'] === 'good-google'));
});

test('OpenRouter says what is left on a key: its own cap first, the account credit otherwise', async (t) => {
  const fake = await fakeProviders();
  t.after(() => fake.close());
  const tester = new ConnectionTester({ bases: bases(fake.url) });
  const stored = secrets({ api_key_openrouter: ['good-or-0000000000000', 'limit-or-000000000000', 'bad-or-00000000000000', 'free-or-0000000000000'] });
  const settings = parseSettings({});
  const good = await tester.test(key('api_key_openrouter', 0), stored, settings);
  assert.deepEqual([good.result.code, good.result.balance, good.result.modelCount], ['ok', { amount: 0.12, currency: 'USD' }, 1]);
  assert.deepEqual(good.models, [{ id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', contextLength: 64000, promptPrice: 0.14, completionPrice: 0.28 }]);
  const capped = await tester.test(key('api_key_openrouter', 1), stored, settings);
  assert.deepEqual([capped.result.code, capped.result.balance], ['no_credit', { amount: 0, currency: 'USD' }]);
  // The models page answers anyone, so a refused key is caught on its own page.
  const bad = await tester.test(key('api_key_openrouter', 2), stored, settings);
  assert.deepEqual([bad.result.code, bad.result.httpStatus], ['invalid_key', 401]);
  // A free account with nothing on it still reaches the free models.
  const free = await tester.test(key('api_key_openrouter', 3), stored, settings);
  assert.deepEqual([free.result.code, free.result.balance], ['ok', { amount: 0, currency: 'USD' }]);
  assert.ok(fake.headers.some((item) => item['x-title'] === 'SillyTavern'));
});

test('proxies are asked with their password, and a wrong one is the proxy refusing', async (t) => {
  const fake = await fakeProviders();
  t.after(() => fake.close());
  const tester = new ConnectionTester({ bases: bases(fake.url), timeoutMs: 2_000 });
  const settings = parseSettings({
    proxies: [
      { name: 'Right', url: `${fake.url}/proxy/v1/`, password: 'proxy-pass' },
      { name: 'Wrong', url: `${fake.url}/proxy/v1`, password: 'nope' },
      { name: 'Page', url: `${fake.url}/html`, password: '' },
      { name: 'Gone', url: 'http://127.0.0.1:1/v1', password: '' },
      { name: 'Typo', url: 'htp//proxy', password: '' },
    ],
  });
  const none = secrets({});
  const code = async (name: string) => (await tester.test({ kind: 'proxy', name }, none, settings)).result.code;
  assert.equal(await code('Right'), 'ok');
  assert.equal(await code('Wrong'), 'proxy_auth');
  assert.equal(await code('Page'), 'bad_url');
  assert.equal(await code('Gone'), 'unreachable');
  assert.equal(await code('Typo'), 'bad_url');
  await assert.rejects(tester.test({ kind: 'proxy', name: 'Missing' }, none, settings), ConnectionTargetMissing);
  await assert.rejects(tester.test(key('api_key_openai', 5), none, settings), ConnectionTargetMissing);
});

test('a profile is tested the way SillyTavern would use it: its proxy, its key, its address', async (t) => {
  const fake = await fakeProviders();
  t.after(() => fake.close());
  const calls: Array<{ path: string; body: unknown }> = [];
  let running = true;
  const sillyTavern: SillyTavernStatusCall = async (path, body) => {
    if (!running) return 'not_running';
    calls.push({ path, body });
    if (path === TEXT_STATUS_PATH) return { status: 200, body: { result: 'koboldcpp/model', data: [{ id: 'koboldcpp/model' }] } };
    return { status: 200, body: (body as { secret_id?: string }).secret_id === 'api_key_chutes-1' ? { error: true, data: { data: [] } } : { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } };
  };
  const tester = new ConnectionTester({ bases: bases(fake.url), sillyTavern });
  const stored = secrets({ api_key_openai: ['bad-openai-active'], api_key_custom: ['good-custom'], api_key_chutes: ['chutes-one', 'chutes-two'], api_key_perplexity: ['pplx'] });
  const settings = parseSettings({
    proxies: [{ name: 'None', url: '', password: '' }, { name: 'Home', url: `${fake.url}/proxy/v1`, password: 'proxy-pass' }],
    oai_settings: { custom_url: `${fake.url}/nowhere` },
    extension_settings: { connectionManager: { profiles: [
      { id: 'via-proxy', mode: 'cc', name: 'GPT via proxy', api: 'openai', proxy: 'Home' },
      { id: 'own-key', mode: 'cc', name: 'GPT', api: 'oai', proxy: 'None' },
      { id: 'custom', mode: 'cc', name: 'Local', api: 'custom', 'api-url': `${fake.url}/custom/v1`, 'secret-id': 'api_key_custom-0' },
      { id: 'deleted', mode: 'cc', name: 'Old', api: 'openai', 'secret-id': 'gone' },
      { id: 'chutes', mode: 'cc', name: 'Chutes', api: 'chutes', 'secret-id': 'api_key_chutes-1' },
      { id: 'kobold', mode: 'tc', name: 'Kobold', api: 'koboldcpp', 'api-url': 'http://127.0.0.1:5001' },
      { id: 'pplx', mode: 'cc', name: 'Perplexity', api: 'perplexity' },
      { id: 'no-key', mode: 'cc', name: 'Claude', api: 'claude' },
    ] } },
  });
  const run = async (id: string) => (await tester.test({ kind: 'profile', id }, stored, settings)).result;
  assert.equal((await run('via-proxy')).code, 'ok');
  // No proxy: the active OpenAI key, which is refused.
  assert.equal((await run('own-key')).code, 'invalid_key');
  // The profile's own address wins over the one in the settings.
  assert.deepEqual([(await run('custom')).code, (await run('custom')).modelCount], ['ok', 1]);
  assert.equal((await run('deleted')).code, 'no_key');
  assert.equal((await run('no-key')).code, 'no_key');
  assert.equal((await run('pplx')).code, 'unsupported');
  const chutes = await run('chutes');
  assert.deepEqual([chutes.code, chutes.via], ['unknown', 'sillytavern']);
  const kobold = await run('kobold');
  assert.deepEqual([kobold.code, kobold.via, kobold.modelCount], ['ok', 'sillytavern', 1]);
  assert.deepEqual(calls, [
    { path: CHAT_STATUS_PATH, body: { chat_completion_source: 'chutes', secret_id: 'api_key_chutes-1' } },
    { path: TEXT_STATUS_PATH, body: { api_server: 'http://127.0.0.1:5001', api_type: 'koboldcpp' } },
  ]);
  // A key only SillyTavern can check, tested through it by id.
  const chutesKey = await tester.test(key('api_key_chutes', 0), stored, settings);
  assert.deepEqual([chutesKey.result.code, chutesKey.result.modelCount, chutesKey.models?.length], ['ok', 3, 3]);
  running = false;
  assert.equal((await run('kobold')).code, 'needs_sillytavern');
  // A custom key with the settings' address, which has nothing there.
  assert.equal((await tester.test(key('api_key_custom', 0), stored, settings)).result.code, 'bad_url');
});

test('the one-token message goes out only when asked, in the shape each provider wants', async (t) => {
  const fake = await fakeProviders();
  t.after(() => fake.close());
  const tester = new ConnectionTester({ bases: bases(fake.url) });
  const stored = secrets({ api_key_openai: ['good-openai'], api_key_claude: ['good-claude'], api_key_makersuite: ['good-google'] });
  const settings = parseSettings({});
  const quiet = await tester.test(key('api_key_openai'), stored, settings);
  assert.equal(quiet.result.sent, false);
  assert.equal(fake.seen.some((line) => line.startsWith('POST')), false);
  const openai = await tester.test(key('api_key_openai'), stored, settings, { send: { model: 'gpt-4o-mini' } });
  assert.deepEqual([openai.result.code, openai.result.sent], ['ok', true]);
  const claude = await tester.test(key('api_key_claude'), stored, settings, { send: { model: 'claude-sonnet-4' } });
  assert.deepEqual([claude.result.code, claude.result.sent], ['ok', true]);
  const google = await tester.test(key('api_key_makersuite'), stored, settings, { send: { model: 'gemini-2.5-pro' } });
  assert.deepEqual([google.result.code, google.result.sent], ['ok', true]);
  assert.deepEqual(fake.seen.filter((line) => line.startsWith('POST')), ['POST /openai/v1/chat/completions', 'POST /claude/v1/messages', 'POST /google/v1beta/models/gemini-2.5-pro:generateContent']);
  assert.deepEqual(fake.bodies, [
    { model: 'gpt-4o-mini', max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'Hi' }] },
    { model: 'claude-sonnet-4', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] },
    { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 1 } },
  ]);
});

test('status codes and bodies are read the way each provider means them', () => {
  assert.equal(classify(401, '', false), 'invalid_key');
  assert.equal(classify(401, '', true), 'proxy_auth');
  assert.equal(classify(403, 'Forbidden', true), 'proxy_auth');
  assert.equal(classify(403, 'Your credit balance is too low', false), 'no_credit');
  assert.equal(classify(402, '', false), 'no_credit');
  assert.equal(classify(429, '{"error":{"type":"insufficient_quota"}}', false), 'no_credit');
  assert.equal(classify(429, 'slow down', false), 'rate_limited');
  assert.equal(classify(400, '{"details":[{"reason":"API_KEY_INVALID"}]}', false), 'invalid_key');
  assert.equal(classify(400, 'bad request', false), 'unknown');
  assert.equal(classify(404, '', false), 'bad_url');
  assert.equal(classify(502, '', false), 'unknown');
  assert.equal(parseModels('openai', { nothing: true }), null);
  assert.deepEqual(parseModels('google', { models: [{ name: 'models/x' }] })?.map((model) => model.id), ['x']);
});

test('results are kept across a restart, and model lists for a day in memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-connection-results-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ConnectionTestStore(paths, 2);
  const result = (testedAt: string) => ({ code: 'ok' as const, via: 'direct' as const, provider: 'openai', httpStatus: 200, latencyMs: 5, modelCount: 1, balance: null, sent: false, testedAt });
  await store.set({ kind: 'proxy', name: 'a' }, result('2026-10-13T01:00:00.000Z'));
  await store.set({ kind: 'proxy', name: 'b' }, result('2026-10-13T02:00:00.000Z'));
  await store.set({ kind: 'proxy', name: 'c' }, result('2026-10-13T03:00:00.000Z'));
  assert.deepEqual(Object.keys(await new ConnectionTestStore(paths).all()).sort(), ['proxy:b', 'proxy:c']);
  // Tests that finish together all keep their result.
  const together = new ConnectionTestStore(getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: await mkdtemp(join(tmpdir(), 'stm-connection-results-')) } }));
  await Promise.all(['a', 'b', 'c', 'd'].map((name) => together.set({ kind: 'proxy', name }, result('2026-10-13T04:00:00.000Z'))));
  assert.deepEqual(Object.keys(await together.all()).sort(), ['proxy:a', 'proxy:b', 'proxy:c', 'proxy:d']);
  let now = 0;
  const cache = new ModelCache(1_000, 50, () => now);
  cache.set({ kind: 'proxy', name: 'a' }, null, [{ id: 'm', name: null, contextLength: null, promptPrice: null, completionPrice: null }]);
  assert.equal(cache.get({ kind: 'proxy', name: 'a' })?.models.length, 1);
  now = 1_000;
  assert.equal(cache.get({ kind: 'proxy', name: 'a' }), null);
});
