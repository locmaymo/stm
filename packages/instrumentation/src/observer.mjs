/* global performance, URL */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';

const wrappedMarker = Symbol.for('sillytavern-manager.instrumented-fetch');

export function installFetchObserver(fetchFunction, options = {}) {
  if (typeof fetchFunction !== 'function' || fetchFunction[wrappedMarker]) return fetchFunction;
  const persist = typeof options.persist === 'function' ? options.persist : createPersistFromEnvironment();
  const reply = typeof options.reply === 'function' ? options.reply : options.persist ? null : createReplyFromEnvironment();
  const wrapped = function managerInstrumentedFetch(input, init) {
    const startedAt = performance.now();
    const details = inspectRequest(input, init);
    details.wantsText = reply !== null;
    // SillyTavern fetches far more than model replies: extension manifests
    // and updates from GitHub, package metadata, fonts, model lists. Every one
    // of those used to land in the usage log as a request to an unknown model.
    /*
     * The start of a finished reply goes to the reply file before the line
     * goes to the usage log, so whoever reads the line finds the words already
     * there. Never into the log itself: that file is read for telemetry and
     * copied to the owner's bucket, and words have no place in either.
     */
    const record = (event, text = '') => {
      if (!isModelRequest(details, event)) return;
      if (!reply || !text || event.cut) { persist(event); return; }
      Promise.resolve().then(() => reply(event.timestamp, text)).catch(() => undefined).finally(() => persist(event));
    };
    let pending;
    try { pending = fetchFunction.call(this, input, init); }
    catch (error) { record(failedEvent(details, startedAt)); throw error; }
    return Promise.resolve(pending).then((response) => observeResponse(response, details, startedAt, record), (error) => {
      record(failedEvent(details, startedAt));
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
  let method = 'GET';
  try { method = String(init?.method ?? input?.method ?? 'GET').toUpperCase(); } catch { /* keep GET */ }
  const details = {
    ignored: isInfrastructure(endpointHost, parsed),
    completionRoute: method === 'POST' && isCompletionRoute(parsed),
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
  const usage = new Usage(details.wantsText === true);
  /*
   * Said once, however the body ends. A reply that stopped before its end -
   * SillyTavern let go of it because the page that asked went away, or the
   * provider dropped the connection - is marked `cut`, so whoever tells the
   * reader about it does not call half a reply a finished one.
   */
  let settled = false;
  const settle = (cut) => {
    if (settled) return;
    settled = true;
    usage.finish();
    persist(eventFrom(details, startedAt, response.status, usage, cut), usage.text());
  };
  try {
    details.stream ||= String(response.headers?.get?.('content-type') ?? '').toLowerCase().includes('text/event-stream');
    if (typeof response.body.getReader === 'function' && typeof globalThis.ReadableStream === 'function') {
      const reader = response.body.getReader();
      const stream = new globalThis.ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) { settle(false); controller.close(); return; }
            usage.feed(result.value, details.stream || response.headers?.get?.('content-type')?.includes('text/event-stream'));
            controller.enqueue(result.value);
          } catch (error) { settle(true); controller.error(error); }
        },
        async cancel(reason) { settle(true); await reader.cancel(reason); },
      });
      return copyWebResponse(response, stream);
    }
    if (typeof response.body.on === 'function' && typeof response.body.pipe === 'function') {
      return copyNodeResponse(response, details, usage, settle);
    }
  } catch { /* instrumentation must never alter a provider response */ }
  persist(eventFrom(details, startedAt, response.status ?? null, usage), usage.text());
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

function copyNodeResponse(response, details, usage, settle) {
  const tap = new Transform({
    transform(chunk, encoding, callback) { usage.feed(chunk, details.stream || String(response.headers?.get?.('content-type') ?? '').includes('text/event-stream')); callback(null, chunk); },
    flush(callback) { settle(false); callback(); },
  });
  // Torn down before the end - aborted, or the body failed - is never flushed,
  // and used to go unrecorded altogether.
  tap.once('close', () => settle(true));
  response.body.once('error', (error) => tap.destroy(error));
  response.body.pipe(tap);
  const WrappedResponse = response.constructor;
  return new WrappedResponse(tap, { status: response.status, statusText: response.statusText, headers: response.headers, url: response.url, size: response.size, highWaterMark: response.highWaterMark });
}

function failedEvent(details, startedAt) { return eventFrom(details, startedAt, null, new Usage()); }
function eventFrom(details, startedAt, status, usage, cut = false) {
  return { schemaVersion: 1, timestamp: new Date().toISOString(), provider: details.provider, completionSource: details.completionSource, model: details.model ?? usage.model, endpointHost: details.endpointHost, stream: details.stream, maxTokens: details.maxTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, reasoningTokens: usage.reasoningTokens, status, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), ...(cut ? { cut: true } : {}) };
}

/** As much of a reply as is ever kept: the start of it, for a notification. */
const REPLY_TEXT_CHARACTERS = 600;
/** A whole answer that is not a stream is read at its end, up to this size. */
const MAX_WHOLE_ANSWER = 512 * 1024;

class Usage {
  inputTokens = null;
  outputTokens = null;
  totalTokens = null;
  cacheReadTokens = null;
  cacheWriteTokens = null;
  reasoningTokens = null;
  model = null;
  #pending = '';
  #wantsText;
  #text = '';
  #whole = '';
  #streamed = false;
  constructor(wantsText = false) { this.#wantsText = wantsText; }
  feed(chunk, stream = false) {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk, { stream: true });
    if (stream) this.#streamed = true;
    else if (this.#wantsText && this.#whole.length < MAX_WHOLE_ANSWER) this.#whole += text;
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
    // An answer that is one JSON document over many lines - Gemini's is - was
    // never readable a line at a time.
    if (this.#wantsText && !this.#text && !this.#streamed && this.#whole) {
      try { this.#text = replyText(JSON.parse(this.#whole)).slice(0, REPLY_TEXT_CHARACTERS); } catch { /* not JSON: no words */ }
    }
    this.#pending = '';
    this.#whole = '';
  }
  /** The start of what the model said, without what it thought first; '' when nobody asked. */
  text() {
    return this.#text.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/giu, '').trim();
  }
  scan(text) {
    if (!text || text.includes('[DONE]')) return;
    if (this.#wantsText && this.#text.length < REPLY_TEXT_CHARACTERS && text.trimStart().startsWith('{')) {
      try { this.#text = `${this.#text}${replyText(JSON.parse(text))}`.slice(0, REPLY_TEXT_CHARACTERS); } catch { /* a line that is not one JSON value */ }
    }
    this.inputTokens = lastNumber(text, ['prompt_tokens', 'input_tokens', 'promptTokenCount', 'inputTokenCount']) ?? this.inputTokens;
    this.outputTokens = lastNumber(text, ['completion_tokens', 'output_tokens', 'candidatesTokenCount', 'outputTokenCount']) ?? this.outputTokens;
    this.totalTokens = lastNumber(text, ['total_tokens', 'totalTokenCount']) ?? this.totalTokens;
    this.cacheReadTokens = lastNumber(text, ['cached_tokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cachedContentTokenCount']) ?? this.cacheReadTokens;
    this.cacheWriteTokens = lastNumber(text, ['cache_creation_input_tokens', 'cache_write_input_tokens', 'cache_creation_tokens', 'cacheWriteTokenCount']) ?? this.cacheWriteTokens;
    this.reasoningTokens = lastNumber(text, ['reasoning_tokens', 'reasoningTokenCount', 'thoughtsTokenCount']) ?? this.reasoningTokens;
    this.model ??= firstString(text, 'model');
  }
}

/**
 * The words in one piece of an answer, across the APIs SillyTavern talks to.
 * Only what is said: reasoning, tool calls and anything marked as a thought
 * are left out.
 */
function replyText(value) {
  if (!value || typeof value !== 'object') return '';
  const string = (item) => (typeof item === 'string' ? item : '');
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  if (choice) return string(choice.delta?.content) || string(choice.message?.content) || string(choice.text); // OpenAI and compatible
  if (value.type === 'response.output_text.delta') return string(value.delta); // OpenAI Responses, streamed
  if (value.type === 'content_block_delta') return value.delta?.type === 'text_delta' ? string(value.delta.text) : ''; // Anthropic, streamed
  if (Array.isArray(value.output)) return value.output.flatMap((item) => (Array.isArray(item?.content) ? item.content : [])).filter((part) => part?.type === 'output_text').map((part) => string(part.text)).join(''); // OpenAI Responses
  if (Array.isArray(value.content)) return value.content.filter((part) => part?.type === 'text').map((part) => string(part.text)).join(''); // Anthropic
  const candidate = Array.isArray(value.candidates) ? value.candidates[0] : null;
  if (Array.isArray(candidate?.content?.parts)) return candidate.content.parts.filter((part) => !part?.thought).map((part) => string(part?.text)).join(''); // Gemini
  if (Array.isArray(value.results)) return string(value.results[0]?.text); // KoboldAI
  if (value.token && typeof value.token === 'object') return value.token.special ? '' : string(value.token.text); // Text Generation Inference
  if (typeof value.content === 'string') return value.content; // llama.cpp
  if (value.message && typeof value.message === 'object') return string(value.message.content); // Ollama chat
  return string(value.response); // Ollama generate
}

/**
 * Whether a request was a call to a model, which is the only thing worth counting.
 *
 * Two independent signs, either of which is enough: the request went to a
 * route that only exists to generate text, or the answer came back reporting
 * how many tokens it used. The second is what catches a proxy that serves a
 * completion from a path nobody could predict. Neither says anything about a
 * download from GitHub, which is the point.
 */
function isModelRequest(details, event) {
  if (details.ignored) return false;
  if (details.completionRoute) return true;
  return event.inputTokens !== null || event.outputTokens !== null || event.totalTokens !== null;
}

/** Routes that generate text, across the APIs SillyTavern can talk to. */
const COMPLETION_ROUTES = [
  /\/chat\/completions\/?$/u, // OpenAI and everything compatible with it
  /\/completions\/?$/u, // OpenAI legacy text completion
  /\/responses\/?$/u, // OpenAI Responses
  /\/messages\/?$/u, // Anthropic
  /\/complete\/?$/u, // Anthropic legacy
  /:(?:stream)?generatecontent$/u, // Google Gemini and Vertex
  /:generate(?:text|message)$/u, // Google PaLM
  /\/api\/(?:v1\/)?generate(?:\/stream)?\/?$/u, // KoboldAI, Ollama
  /\/api\/extra\/generate\/stream\/?$/u, // KoboldCpp
  /\/api\/chat\/?$/u, // Ollama
  /\/completion\/?$/u, // llama.cpp server
  /\/generate(?:_stream)?\/?$/u, // Text Generation Inference
  /\/v[12]\/chat\/?$/u, // Cohere
  /\/converse(?:-stream)?\/?$/u, // AWS Bedrock
  /\/invoke(?:-with-response-stream)?\/?$/u, // AWS Bedrock
  /\/predictions\/?$/u, // Replicate
];

function isCompletionRoute(url) {
  const path = url?.pathname?.toLowerCase();
  return Boolean(path) && COMPLETION_ROUTES.some((route) => route.test(path));
}

/**
 * Hosts that serve code, packages and files, never a model reply.
 *
 * Checked before anything else, so a manifest that happens to contain the
 * word "usage" cannot be counted either.
 */
const INFRASTRUCTURE_HOSTS = new Set([
  'github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'gist.githubusercontent.com', 'release-assets.githubusercontent.com',
  'gitlab.com', 'bitbucket.org', 'registry.npmjs.org', 'cdn.jsdelivr.net', 'unpkg.com',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs.hf.co',
]);
const FILE_EXTENSION = /\.(?:js|mjs|cjs|css|json|jsonl|md|txt|html?|xml|ya?ml|png|jpe?g|gif|webp|avif|svg|ico|zip|tgz|gz|tar|woff2?|ttf|onnx|bin|safetensors|gguf|wasm)$/u;

function isInfrastructure(host, url) {
  if (host && INFRASTRUCTURE_HOSTS.has(host)) return true;
  return FILE_EXTENSION.test(url?.pathname?.toLowerCase() ?? '');
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

/**
 * Where the start of the last finished reply is put, when the manager asked:
 * one small file, written over each time, read by the manager to tell a phone
 * what the character said.
 */
export function createReplyFromEnvironment() {
  const file = typeof process.env.STM_REPLY_FILE === 'string' && process.env.STM_REPLY_FILE.length > 0 ? process.env.STM_REPLY_FILE : null;
  if (!file) return null;
  return async (timestamp, text) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ timestamp, text })}\n`, { encoding: 'utf8', mode: 0o600 });
  };
}

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
