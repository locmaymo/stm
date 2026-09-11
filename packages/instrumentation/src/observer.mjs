/* global performance, URL */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';

const wrappedMarker = Symbol.for('sillytavern-manager.instrumented-fetch');

export function installFetchObserver(fetchFunction, options = {}) {
  if (typeof fetchFunction !== 'function' || fetchFunction[wrappedMarker]) return fetchFunction;
  const persist = typeof options.persist === 'function' ? options.persist : createPersistFromEnvironment();
  const wrapped = function managerInstrumentedFetch(input, init) {
    const startedAt = performance.now();
    const details = inspectRequest(input, init);
    let pending;
    try { pending = fetchFunction.call(this, input, init); }
    catch (error) { persist(failedEvent(details, startedAt)); throw error; }
    return Promise.resolve(pending).then((response) => observeResponse(response, details, startedAt, persist), (error) => {
      persist(failedEvent(details, startedAt));
      throw error;
    });
  };
  Object.defineProperty(wrapped, wrappedMarker, { value: true });
  try { Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fetchFunction)); } catch { /* callable wrappers may be sealed */ }
  return wrapped;
}

function inspectRequest(input, init) {
  let url = '';
  try { url = typeof input === 'string' ? input : input?.url ?? String(input); } catch { /* use unknown */ }
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  const endpointHost = safeHost(parsed);
  const details = {
    provider: providerFor(endpointHost, parsed),
    completionSource: completionSourceFor(endpointHost, parsed),
    model: modelFromUrl(parsed),
    endpointHost,
    stream: Boolean(parsed?.pathname?.includes(':streamGenerateContent')),
    maxTokens: null,
  };
  const body = init?.body;
  if (typeof body !== 'string') return details;
  // Only scalar allowlist values are inspected. The request body is never
  // retained, serialized, or included in the event.
  details.model ??= lastString(body, 'model');
  details.maxTokens = lastNumber(body, ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxOutputTokens']);
  details.stream ||= /"stream"\s*:\s*true/iu.test(body);
  return details;
}

function observeResponse(response, details, startedAt, persist) {
  if (!response || !response.body) {
    persist(eventFrom(details, startedAt, response?.status ?? null, new Usage()));
    return response;
  }
  const usage = new Usage();
  try {
    details.stream ||= String(response.headers?.get?.('content-type') ?? '').toLowerCase().includes('text/event-stream');
    if (typeof response.body.getReader === 'function' && typeof globalThis.ReadableStream === 'function') {
      const reader = response.body.getReader();
      const stream = new globalThis.ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) { usage.finish(); persist(eventFrom(details, startedAt, response.status, usage)); controller.close(); return; }
            usage.feed(result.value, details.stream || response.headers?.get?.('content-type')?.includes('text/event-stream'));
            controller.enqueue(result.value);
          } catch (error) { usage.finish(); persist(eventFrom(details, startedAt, response.status, usage)); controller.error(error); }
        },
        async cancel(reason) { usage.finish(); persist(eventFrom(details, startedAt, response.status, usage)); await reader.cancel(reason); },
      });
      return copyWebResponse(response, stream);
    }
    if (typeof response.body.on === 'function' && typeof response.body.pipe === 'function') {
      return copyNodeResponse(response, details, startedAt, usage, persist);
    }
  } catch { /* instrumentation must never alter a provider response */ }
  persist(eventFrom(details, startedAt, response.status ?? null, usage));
  return response;
}

function copyWebResponse(response, body) {
  const WrappedResponse = response.constructor ?? globalThis.Response;
  const wrapped = new WrappedResponse(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ['url', 'redirected', 'type']) {
    try { Object.defineProperty(wrapped, key, { configurable: true, value: response[key] }); } catch { /* optional metadata */ }
  }
  return wrapped;
}

function copyNodeResponse(response, details, startedAt, usage, persist) {
  const tap = new Transform({
    transform(chunk, encoding, callback) { usage.feed(chunk, details.stream || String(response.headers?.get?.('content-type') ?? '').includes('text/event-stream')); callback(null, chunk); },
    flush(callback) { usage.finish(); persist(eventFrom(details, startedAt, response.status, usage)); callback(); },
  });
  response.body.once('error', (error) => tap.destroy(error));
  response.body.pipe(tap);
  const WrappedResponse = response.constructor;
  return new WrappedResponse(tap, { status: response.status, statusText: response.statusText, headers: response.headers, url: response.url, size: response.size, highWaterMark: response.highWaterMark });
}

function failedEvent(details, startedAt) { return eventFrom(details, startedAt, null, new Usage()); }
function eventFrom(details, startedAt, status, usage) {
  return { schemaVersion: 1, timestamp: new Date().toISOString(), provider: details.provider, completionSource: details.completionSource, model: details.model ?? usage.model, endpointHost: details.endpointHost, stream: details.stream, maxTokens: details.maxTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, reasoningTokens: usage.reasoningTokens, status, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) };
}

class Usage {
  inputTokens = null;
  outputTokens = null;
  totalTokens = null;
  cacheReadTokens = null;
  cacheWriteTokens = null;
  reasoningTokens = null;
  model = null;
  #pending = '';
  feed(chunk, stream = false) {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk, { stream: true });
    this.#pending = `${this.#pending}${text}`.slice(-131072);
    const lines = this.#pending.split(/\r?\n/u);
    this.#pending = lines.pop() ?? '';
    for (const line of lines) this.scan(stream ? (line.startsWith('data:') ? line.slice(5) : '') : line);
  }
  finish() {
    this.scan(this.#pending.startsWith('data:') ? this.#pending.slice(5) : this.#pending);
    if (this.inputTokens === 0 && this.totalTokens !== null && this.outputTokens !== null && this.totalTokens >= this.outputTokens) {
      this.inputTokens = this.totalTokens - this.outputTokens;
    }
    this.#pending = '';
  }
  scan(text) {
    if (!text || text.includes('[DONE]')) return;
    this.inputTokens = lastNumber(text, ['prompt_tokens', 'input_tokens', 'promptTokenCount', 'inputTokenCount']) ?? this.inputTokens;
    this.outputTokens = lastNumber(text, ['completion_tokens', 'output_tokens', 'candidatesTokenCount', 'outputTokenCount']) ?? this.outputTokens;
    this.totalTokens = lastNumber(text, ['total_tokens', 'totalTokenCount']) ?? this.totalTokens;
    this.cacheReadTokens = lastNumber(text, ['cached_tokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cachedContentTokenCount']) ?? this.cacheReadTokens;
    this.cacheWriteTokens = lastNumber(text, ['cache_creation_input_tokens', 'cache_write_input_tokens', 'cache_creation_tokens', 'cacheWriteTokenCount']) ?? this.cacheWriteTokens;
    this.reasoningTokens = lastNumber(text, ['reasoning_tokens', 'reasoningTokenCount', 'thoughtsTokenCount']) ?? this.reasoningTokens;
    this.model ??= firstString(text, 'model');
  }
}

function lastNumber(text, keys) { let value = null; for (const key of keys) { const matches = [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'gu'))]; const match = matches.at(-1); if (match) value = Number(match[1]); } return value; }
function providerFor(host) {
  if (!host) return 'unknown';
  if (isOfficialOpenAiHost(host)) return 'openai';
  if (isOfficialAnthropicHost(host)) return 'anthropic';
  if (isOfficialGoogleHost(host)) return 'google';
  return host;
}
function completionSourceFor(host, url) {
  const path = url?.pathname ?? '';
  if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) return 'google';
  if (isOfficialOpenAiHost(host) || /\/chat\/completions(?:\/|$)/u.test(path)) return 'openai';
  if (isOfficialAnthropicHost(host) || /\/messages(?:\/|$)/u.test(path)) return 'anthropic';
  if (isOfficialGoogleHost(host)) return 'google';
  return null;
}
function isOfficialOpenAiHost(host) { return host === 'api.openai.com'; }
function isOfficialAnthropicHost(host) { return host === 'api.anthropic.com'; }
function isOfficialGoogleHost(host) {
  return Boolean(host) && (host === 'generativelanguage.googleapis.com' || host === 'aiplatform.googleapis.com' || host.endsWith('.aiplatform.googleapis.com'));
}
function safeHost(url) { if (!url?.hostname || /^[\d.]+$/u.test(url.hostname) || url.hostname.includes(':')) return null; return url.hostname.toLowerCase().replace(/\.$/u, ''); }
function modelFromUrl(url) {
  if (!url) return null;
  const pathMatch = /\/models\/([^/:?#]+)(?::|\/|$)/u.exec(url.pathname);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]).slice(0, 256);
  const queryModel = url.searchParams.get('model');
  return queryModel ? queryModel.slice(0, 256) : null;
}
function firstString(text, key) { const match = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]{1,256})"`, 'u').exec(text); return match?.[1] ?? null; }
function lastString(text, key) { const matches = [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]{1,256})"`, 'gu'))]; return matches.at(-1)?.[1] ?? null; }

function createPersistFromEnvironment() {
  const file = typeof process.env.STM_METRICS_FILE === 'string' && process.env.STM_METRICS_FILE.length > 0 ? process.env.STM_METRICS_FILE : null;
  let writeQueue = Promise.resolve();
  process.on('beforeExit', () => writeQueue);
  return (event) => {
    if (!file) return;
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => undefined);
  };
}
