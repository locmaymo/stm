import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectionApiProvider, connectionTargetKey, type ConnectionBalance, type ConnectionModel, type ConnectionModelList, type ConnectionTarget, type ConnectionTestCode, type ConnectionTestResult } from '../../../packages/contracts/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';
import { providerOf, type StoredSecret, type StoredSecrets, type StoredSettings } from './connections.js';

/**
 * Testing a key, a proxy or a connection profile: does it still work, and how
 * much is left on it.
 *
 * Two ways, chosen per provider:
 *
 * 1. Straight from the manager to the provider, for the providers in
 *    `DIRECT_PROVIDERS`. This tests any key, not only the active one, and
 *    reads the balance where the provider tells it (OpenRouter, DeepSeek).
 * 2. Through SillyTavern's own check (`/api/backends/chat-completions/status`
 *    and its text-completion twin), for the sources only SillyTavern knows
 *    how to ask. It needs SillyTavern running and says less: it lists models
 *    or it does not, and never says why.
 *
 * Calls go out from this machine, as SillyTavern's would. A key is read from
 * `secrets.json` at the moment of the call and goes nowhere but to its
 * provider. Nothing a provider answers is logged or kept beyond the result
 * code, the counts and the balance; the model list is kept in memory for a
 * day. Nothing is ever sent to a provider without being asked: the one-token
 * message costs a little and is its own button.
 */

export interface ProviderSpec {
  /** Where the API is; empty for one whose address the user gives (custom). */
  readonly base: string;
  readonly auth: 'bearer' | 'x-api-key' | 'goog';
  /** Where the model list is, under `base`. */
  readonly modelsPath: string;
  /** How a message is sent and a model list read. */
  readonly format: 'openai' | 'claude' | 'google' | 'cohere';
  /** SillyTavern sends this source through a reverse proxy preset when one is selected. */
  readonly proxyable: boolean;
}

/** The providers the manager asks itself, as SillyTavern 1.19.0 reaches them. */
export const DIRECT_PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
  openrouter: { base: 'https://openrouter.ai/api/v1', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: false },
  openai: { base: 'https://api.openai.com/v1', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: true },
  custom: { base: '', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: false },
  claude: { base: 'https://api.anthropic.com/v1', auth: 'x-api-key', modelsPath: '/models', format: 'claude', proxyable: true },
  makersuite: { base: 'https://generativelanguage.googleapis.com', auth: 'goog', modelsPath: '/v1beta/models', format: 'google', proxyable: true },
  deepseek: { base: 'https://api.deepseek.com', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: true },
  mistralai: { base: 'https://api.mistral.ai/v1', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: true },
  cohere: { base: 'https://api.cohere.ai/v1', auth: 'bearer', modelsPath: '/models', format: 'cohere', proxyable: false },
  groq: { base: 'https://api.groq.com/openai/v1', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: false },
  xai: { base: 'https://api.x.ai/v1', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: true },
};

/**
 * Chat completion sources SillyTavern's own check lists models for with
 * nothing but a key, beyond the direct ones. Others it either cannot check
 * (Claude, Perplexity) or needs settings the manager does not read (Azure,
 * Workers AI).
 */
export const SILLYTAVERN_STATUS_SOURCES: readonly string[] = ['chutes', 'electronhub', 'nanogpt', 'aimlapi', 'pollinations', 'moonshot', 'fireworks', 'siliconflow'];

export const CHAT_STATUS_PATH = '/api/backends/chat-completions/status';
export const TEXT_STATUS_PATH = '/api/backends/text-completions/status';

/** What SillyTavern's check answered, or that it is not running. */
export type SillyTavernStatusCall = (path: string, body: unknown) => Promise<{ readonly status: number; readonly body: unknown } | 'not_running'>;

export class ConnectionTargetMissing extends Error {
  public readonly code = 'connection_target_missing';
}

export interface ConnectionTesterOptions {
  readonly fetch?: typeof fetch;
  /** Where each provider is, for tests; the real address otherwise. */
  readonly bases?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly sillyTavern?: SillyTavernStatusCall;
}

export interface TestOptions {
  /** Send a one-token message to this model as well. */
  readonly send?: { readonly model: string };
}

export interface TestOutcome {
  readonly result: ConnectionTestResult;
  /** The models it can reach, when the provider listed them. */
  readonly models: readonly ConnectionModel[] | null;
}

/** How a target will be tested. */
type Probe =
  | { readonly way: 'direct'; readonly provider: string | null; readonly spec: ProviderSpec; readonly base: string; readonly key: string; readonly proxy: boolean }
  | { readonly way: 'sillytavern'; readonly provider: string | null; readonly path: string; readonly body: Readonly<Record<string, unknown>> }
  | { readonly way: 'none'; readonly provider: string | null; readonly code: ConnectionTestCode };

/** What a provider's answer means: the code, and the parsed body for one that worked. */
interface Answer {
  readonly code: ConnectionTestCode;
  readonly status: number | null;
  readonly body: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Enough to tell an error apart; nothing beyond it is read. */
const MAX_ERROR_BYTES = 8 * 1024;
/** A provider listing more than this is listing something other than models. */
const MAX_MODELS = 5_000;
/** OpenRouter wants to know who is calling; these are SillyTavern's own. */
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://sillytavern.app', 'X-Title': 'SillyTavern' };
/** The NO proxy preset's name. */
const NO_PROXY = 'None';

export class ConnectionTester {
  private readonly fetchImpl: typeof fetch;
  private readonly bases: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly sillyTavern: SillyTavernStatusCall;

  public constructor(options: ConnectionTesterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.bases = options.bases ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.sillyTavern = options.sillyTavern ?? (async () => 'not_running');
  }

  /** Test one target against the files as they are now. */
  public async test(target: ConnectionTarget, secrets: StoredSecrets, settings: StoredSettings, options: TestOptions = {}): Promise<TestOutcome> {
    const probe = this.probe(target, secrets, settings);
    const started = Date.now();
    if (probe.way === 'none') return { result: this.result(probe.code, null, probe.provider, null, null, null, null, false), models: null };
    if (probe.way === 'sillytavern') return this.throughSillyTavern(probe, started);
    return this.direct(probe, started, options.send?.model ?? null);
  }

  /** How a target would be tested, worked out from the files. */
  private probe(target: ConnectionTarget, secrets: StoredSecrets, settings: StoredSettings): Probe {
    if (target.kind === 'key') {
      const secret = secrets.secrets.find((item) => item.secretKey === target.secretKey && item.id === target.id);
      if (!secret) throw new ConnectionTargetMissing('That key is no longer in SillyTavern');
      const provider = providerOf(secret.secretKey);
      return this.keyProbe(provider, secret, provider === 'custom' ? text(settings.oai.custom_url) : null);
    }
    if (target.kind === 'proxy') {
      const proxy = settings.proxies.find((item) => item.name === target.name);
      if (!proxy) throw new ConnectionTargetMissing('That proxy is no longer in SillyTavern');
      return this.proxyProbe(null, proxy.url, proxy.password, OPENAI_COMPATIBLE);
    }
    const profile = settings.profiles.find((item) => item.id === target.id);
    if (!profile) throw new ConnectionTargetMissing('That connection profile is no longer in SillyTavern');
    const api = text(profile.api);
    const apiUrl = text(profile['api-url']);
    if (profile.mode === 'tc') {
      if (!api || !apiUrl) return { way: 'none', provider: api, code: 'unsupported' };
      return { way: 'sillytavern', provider: api, path: TEXT_STATUS_PATH, body: { api_server: apiUrl, api_type: api } };
    }
    const provider = connectionApiProvider(api ?? text(settings.oai.chat_completion_source) ?? 'openai');
    const spec = DIRECT_PROVIDERS[provider];
    const proxyName = text(profile.proxy);
    if (proxyName && proxyName !== NO_PROXY && spec?.proxyable) {
      const proxy = settings.proxies.find((item) => item.name === proxyName);
      if (proxy && proxy.url.trim() !== '') return this.proxyProbe(provider, proxy.url, proxy.password, spec);
    }
    const secretId = text(profile['secret-id']);
    const secretKey = `api_key_${provider}`;
    const secret = secretId
      ? secrets.secrets.find((item) => item.id === secretId) ?? null
      : secrets.secrets.find((item) => item.secretKey === secretKey && item.active) ?? null;
    if (!secret && (secretId || provider !== 'custom')) return { way: 'none', provider, code: 'no_key' };
    return this.keyProbe(provider, secret, provider === 'custom' ? apiUrl ?? text(settings.oai.custom_url) : null);
  }

  private keyProbe(provider: string, secret: StoredSecret | null, customUrl: string | null): Probe {
    const spec = DIRECT_PROVIDERS[provider];
    if (spec) {
      const base = provider === 'custom' ? customUrl : this.bases[provider] ?? spec.base;
      if (!base || !isHttpAddress(base)) return { way: 'none', provider, code: 'bad_url' };
      return { way: 'direct', provider, spec, base, key: secret?.value ?? '', proxy: false };
    }
    if (SILLYTAVERN_STATUS_SOURCES.includes(provider)) {
      return { way: 'sillytavern', provider, path: CHAT_STATUS_PATH, body: { chat_completion_source: provider, ...(secret?.id ? { secret_id: secret.id } : {}) } };
    }
    return { way: 'none', provider, code: 'unsupported' };
  }

  private proxyProbe(provider: string | null, url: string, password: string, spec: ProviderSpec): Probe {
    if (!isHttpAddress(url)) return { way: 'none', provider, code: 'bad_url' };
    return { way: 'direct', provider, spec, base: url.trim(), key: password, proxy: true };
  }

  private async direct(probe: Extract<Probe, { way: 'direct' }>, started: number, sendModel: string | null): Promise<TestOutcome> {
    const { spec, base, proxy, provider } = probe;
    let balance: ConnectionBalance | null = null;
    let code: ConnectionTestCode = 'ok';
    // OpenRouter lists its models to anyone, so the key is tried on its own
    // page first, which also says what is left on it.
    if (provider === 'openrouter' && !proxy) {
      const key = await this.call('GET', `${trim(base)}/key`, probe);
      if (key.code !== 'ok') return { result: this.result(key.code, 'direct', provider, key.status, Date.now() - started, null, null, false), models: null };
      const data = record(record(key.body).data);
      const remaining = numberOf(data.limit_remaining);
      if (data.limit !== null && data.limit !== undefined && remaining !== null) {
        balance = { amount: remaining, currency: 'USD' };
        if (remaining <= 0) code = 'no_credit';
      } else {
        const credits = await this.call('GET', `${trim(base)}/credits`, probe);
        const total = record(record(credits.body).data);
        const bought = numberOf(total.total_credits);
        const used = numberOf(total.total_usage);
        if (credits.code === 'ok' && bought !== null && used !== null) {
          balance = { amount: round(bought - used), currency: 'USD' };
          // A free account has never paid and still reaches the free models.
          if (bought - used <= 0 && data.is_free_tier !== true) code = 'no_credit';
        }
      }
    }
    const listed = await this.call('GET', `${trim(base)}${spec.modelsPath}`, probe);
    const latencyMs = Date.now() - started;
    if (listed.code !== 'ok') return { result: this.result(listed.code, 'direct', provider, listed.status, latencyMs, null, balance, false), models: null };
    const models = parseModels(spec.format, listed.body);
    if (!models) return { result: this.result('bad_url', 'direct', provider, listed.status, latencyMs, null, balance, false), models: null };
    if (provider === 'deepseek' && !proxy) {
      const answer = await this.call('GET', `${trim(base)}/user/balance`, probe);
      const body = record(answer.body);
      const info = record(Array.isArray(body.balance_infos) ? body.balance_infos[0] : null);
      const amount = numberOf(info.total_balance);
      if (answer.code === 'ok' && amount !== null) balance = { amount, currency: typeof info.currency === 'string' ? info.currency : 'USD' };
      if (answer.code === 'ok' && body.is_available === false) code = 'no_credit';
    }
    let sent = false;
    if (sendModel) {
      const message = await this.send(probe, sendModel);
      sent = message.code === 'ok';
      if (message.code !== 'ok') return { result: this.result(message.code, 'direct', provider, message.status, Date.now() - started, models.length, balance, false), models };
    }
    return { result: this.result(code, 'direct', provider, listed.status, latencyMs, models.length, balance, sent), models };
  }

  /** One message of one token, the cheapest thing that proves a reply would come. */
  private async send(probe: Extract<Probe, { way: 'direct' }>, model: string): Promise<Answer> {
    const base = trim(probe.base);
    const question = 'Hi';
    if (probe.spec.format === 'claude') return this.call('POST', `${base}/messages`, probe, { model, max_tokens: 1, messages: [{ role: 'user', content: question }] });
    if (probe.spec.format === 'google') {
      return this.call('POST', `${base}/v1beta/models/${encodeURIComponent(model.replace(/^models\//u, ''))}:generateContent`, probe, { contents: [{ role: 'user', parts: [{ text: question }] }], generationConfig: { maxOutputTokens: 1 } });
    }
    if (probe.spec.format === 'cohere') return this.call('POST', `${base.replace(/\/v1$/u, '')}/v2/chat`, probe, { model, max_tokens: 1, messages: [{ role: 'user', content: question }] });
    return this.call('POST', `${base}/chat/completions`, probe, { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: question }] });
  }

  private async throughSillyTavern(probe: Extract<Probe, { way: 'sillytavern' }>, started: number): Promise<TestOutcome> {
    let answer: Awaited<ReturnType<SillyTavernStatusCall>>;
    try {
      answer = await this.sillyTavern(probe.path, probe.body);
    } catch {
      return { result: this.result('unknown', 'sillytavern', probe.provider, null, Date.now() - started, null, null, false), models: null };
    }
    const latencyMs = Date.now() - started;
    if (answer === 'not_running') return { result: this.result('needs_sillytavern', null, probe.provider, null, null, null, null, false), models: null };
    const body = record(answer.body);
    // SillyTavern answers a check that failed with 200 and `error: true`, or
    // with 400 when it could not even start one, and never says why.
    if (answer.status < 200 || answer.status >= 300 || body.error === true) {
      const code = probe.path === TEXT_STATUS_PATH ? 'unreachable' : 'unknown';
      return { result: this.result(code, 'sillytavern', probe.provider, null, latencyMs, null, null, false), models: null };
    }
    // Most sources answer in OpenAI's shape; Cohere keeps its own `models`.
    const models = parseModels('openai', body) ?? parseModels('cohere', body) ?? [];
    return { result: this.result('ok', 'sillytavern', probe.provider, null, latencyMs, models.length, null, false), models: models.length > 0 ? models : null };
  }

  /** One request to a provider, read as far as is needed to say what it meant. */
  private async call(method: 'GET' | 'POST', url: string, probe: Extract<Probe, { way: 'direct' }>, body?: unknown): Promise<Answer> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (probe.key !== '') {
      if (probe.spec.auth === 'x-api-key') headers['x-api-key'] = probe.key;
      else if (probe.spec.auth === 'goog') headers['x-goog-api-key'] = probe.key;
      else headers.authorization = `Bearer ${probe.key}`;
    }
    if (probe.spec.format === 'claude') headers['anthropic-version'] = '2023-06-01';
    if (probe.provider === 'openrouter' && !probe.proxy) Object.assign(headers, OPENROUTER_HEADERS);
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error: unknown) {
      return { code: error instanceof TypeError && /invalid url|failed to parse url/iu.test(String(error.cause ?? error.message)) ? 'bad_url' : 'unreachable', status: null, body: null };
    }
    if (response.ok) {
      const parsed: unknown = await response.json().catch(() => undefined);
      // Something that answers with a web page is not the API it was meant to be.
      return parsed === undefined ? { code: 'bad_url', status: response.status, body: null } : { code: 'ok', status: response.status, body: parsed };
    }
    return { code: classify(response.status, await readSome(response), probe.proxy), status: response.status, body: null };
  }

  private result(code: ConnectionTestCode, via: ConnectionTestResult['via'], provider: string | null, httpStatus: number | null, latencyMs: number | null, modelCount: number | null, balance: ConnectionBalance | null, sent: boolean): ConnectionTestResult {
    return { code, via, provider, httpStatus, latencyMs, modelCount, balance, sent, testedAt: this.now().toISOString() };
  }
}

/** An OpenAI-compatible endpoint, for a proxy whose format is not known. */
const OPENAI_COMPATIBLE: ProviderSpec = { base: '', auth: 'bearer', modelsPath: '/models', format: 'openai', proxyable: true };

/**
 * What an error status means, from the status and the first part of the
 * body. Providers disagree: OpenAI says it is out of quota with a 429,
 * Google says the key is wrong with a 400, OpenRouter says no credit with a
 * 402. A proxy that refuses is refusing its own password, not the provider's
 * key.
 */
export function classify(status: number, body: string, proxy: boolean): ConnectionTestCode {
  const credit = /insufficient_quota|insufficient[_ ]balance|credit|billing|quota|balance|payment/iu.test(body);
  const badKey = /api_key_invalid|api key not valid|invalid[_ ]api[_ ]key|incorrect api key|invalid x-api-key|authentication/iu.test(body);
  if (status === 401) return proxy ? 'proxy_auth' : 'invalid_key';
  if (status === 402) return 'no_credit';
  if (status === 403) return proxy ? 'proxy_auth' : credit ? 'no_credit' : 'invalid_key';
  if (status === 429) return credit ? 'no_credit' : 'rate_limited';
  if (status === 400) return badKey ? 'invalid_key' : credit ? 'no_credit' : 'unknown';
  if (status === 404 || status === 405) return 'bad_url';
  return 'unknown';
}

/** The models in a provider's list, or null when it is not a list of models. */
export function parseModels(format: ProviderSpec['format'], body: unknown): ConnectionModel[] | null {
  const root = record(body);
  const items = format === 'google' || format === 'cohere'
    ? root.models
    : root.data ?? (Array.isArray(body) ? body : undefined);
  if (!Array.isArray(items)) return null;
  const models: ConnectionModel[] = [];
  for (const raw of items.slice(0, MAX_MODELS)) {
    const item = record(raw);
    const rawId = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : null;
    if (!rawId) continue;
    const id = format === 'google' ? rawId.replace(/^models\//u, '') : rawId;
    const pricing = record(item.pricing);
    const name = typeof item.display_name === 'string' ? item.display_name
      : typeof item.displayName === 'string' ? item.displayName
        : typeof item.name === 'string' && item.name !== rawId ? item.name
          : null;
    models.push({
      id,
      name,
      contextLength: numberOf(item.context_length) ?? numberOf(item.inputTokenLimit) ?? numberOf(item.max_context_length),
      promptPrice: perMillion(pricing.prompt),
      completionPrice: perMillion(pricing.completion),
    });
  }
  return models;
}

/**
 * The last test of every target, kept on disk so the page shows it after a
 * restart. Small: one line of numbers per key, proxy and profile, and never
 * anything a provider said.
 */
export class ConnectionTestStore {
  private readonly file: string;
  private cache: Record<string, ConnectionTestResult> | null = null;
  private writing: Promise<void> = Promise.resolve();

  public constructor(paths: PlatformPaths, private readonly maxKept = 300) {
    this.file = join(paths.state, 'connection-tests.json');
  }

  public async all(): Promise<Readonly<Record<string, ConnectionTestResult>>> {
    if (this.cache) return this.cache;
    let read: Record<string, ConnectionTestResult> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (isRecord(parsed) && isRecord(parsed.results)) read = parsed.results as Record<string, ConnectionTestResult>;
    } catch { /* nothing kept yet */ }
    // Another caller may have read it, and changed it, while this one waited.
    this.cache ??= read;
    return this.cache;
  }

  /*
   * Tests run side by side, so each change is made to what is there once
   * the file has been read, in one step with nothing awaited in between;
   * one made to a copy taken before another test finished would lose it.
   */
  public async set(target: ConnectionTarget, result: ConnectionTestResult): Promise<void> {
    await this.all();
    const results = { ...this.cache, [connectionTargetKey(target)]: result };
    const kept = Object.entries(results).sort(([, a], [, b]) => b.testedAt.localeCompare(a.testedAt)).slice(0, this.maxKept);
    this.cache = Object.fromEntries(kept);
    const snapshot = JSON.stringify({ schemaVersion: 1, results: this.cache });
    this.writing = this.writing.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    }).catch(() => undefined);
    await this.writing;
  }
}

/**
 * The model lists tests brought back, for a day, in memory only: a list is
 * there to search, and a day-old one is still right often enough.
 */
export class ModelCache {
  private readonly lists = new Map<string, { readonly list: ConnectionModelList; readonly expires: number }>();

  public constructor(private readonly ttlMs = 24 * 60 * 60 * 1000, private readonly maxLists = 50, private readonly now: () => number = Date.now) {}

  public set(target: ConnectionTarget, provider: string | null, models: readonly ConnectionModel[]): void {
    const key = connectionTargetKey(target);
    this.lists.delete(key);
    this.lists.set(key, { list: { provider: provider ?? 'proxy', models, fetchedAt: new Date(this.now()).toISOString() }, expires: this.now() + this.ttlMs });
    while (this.lists.size > this.maxLists) this.lists.delete(this.lists.keys().next().value ?? '');
  }

  public get(target: ConnectionTarget): ConnectionModelList | null {
    const key = connectionTargetKey(target);
    const entry = this.lists.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.lists.delete(key); return null; }
    return entry.list;
  }
}

async function readSome(response: Response): Promise<string> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, MAX_ERROR_BYTES).toString('utf8');
  } catch {
    return '';
  }
}

function isHttpAddress(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function trim(base: string): string {
  return base.trim().replace(/\/+$/u, '');
}

/** OpenRouter's price per token, as dollars per million tokens. */
function perMillion(value: unknown): number | null {
  const price = numberOf(value);
  return price === null || price < 0 ? null : round(price * 1_000_000);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function numberOf(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
