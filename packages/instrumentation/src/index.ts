import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MetricsBucket, MetricsSnapshot, MetricsTotals, UsageEvent } from '../../contracts/src/index.js';

export type { MetricsBucket, MetricsSnapshot, MetricsTotals, UsageEvent };

export const instrumentationLoaderPath = pathToFileURL(fileURLToPath(new URL('./loader.mjs', import.meta.url))).href;

export function isUsageEvent(value: unknown): value is UsageEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return event.schemaVersion === 1
    && typeof event.timestamp === 'string'
    && typeof event.provider === 'string'
    && (typeof event.completionSource === 'string' || event.completionSource === null || event.completionSource === undefined)
    && (typeof event.model === 'string' || event.model === null)
    && (typeof event.endpointHost === 'string' || event.endpointHost === null)
    && typeof event.stream === 'boolean'
    && (typeof event.maxTokens === 'number' || event.maxTokens === null)
    && (typeof event.inputTokens === 'number' || event.inputTokens === null)
    && (typeof event.outputTokens === 'number' || event.outputTokens === null)
    && (typeof event.totalTokens === 'number' || event.totalTokens === null)
    && (typeof event.cacheReadTokens === 'number' || event.cacheReadTokens === null || event.cacheReadTokens === undefined)
    && (typeof event.cacheWriteTokens === 'number' || event.cacheWriteTokens === null || event.cacheWriteTokens === undefined)
    && (typeof event.reasoningTokens === 'number' || event.reasoningTokens === null || event.reasoningTokens === undefined)
    && (typeof event.status === 'number' || event.status === null)
    && typeof event.durationMs === 'number'
    && Number.isFinite(event.durationMs);
}

export function aggregateUsageEvents(events: Iterable<UsageEvent>, now = new Date(), days = 30): MetricsSnapshot {
  const end = now;
  const from = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const totals = emptyTotals();
  const daily = new Map<string, MetricsBucket>();
  const providers = new Map<string, MetricsBucket>();
  const models = new Map<string, MetricsBucket>();
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < from.getTime() || timestamp > end.getTime()) continue;
    const normalized = normalizeEvent(event);
    addEvent(totals, normalized);
    addBucket(daily, event.timestamp.slice(0, 10), normalized);
    addBucket(providers, normalized.provider, normalized, { provider: normalized.provider });
    addBucket(models, normalized.model ?? 'unknown', normalized, { model: normalized.model ?? 'unknown' });
  }
  finalizeTotals(totals);
  for (const bucket of [...daily.values(), ...providers.values(), ...models.values()]) finalizeTotals(bucket as MutableBucket);
  return {
    generatedAt: end.toISOString(),
    range: { from: from.toISOString(), to: end.toISOString() },
    totals,
    daily: [...daily.values()].sort((left, right) => left.key.localeCompare(right.key)),
    providers: [...providers.values()].sort((left, right) => right.requests - left.requests || left.key.localeCompare(right.key)),
    models: [...models.values()].sort((left, right) => right.requests - left.requests || left.key.localeCompare(right.key)),
  };
}

type MutableTotals = { -readonly [Key in keyof MetricsTotals]: MetricsTotals[Key] };
type MutableBucket = { -readonly [Key in keyof MetricsBucket]: MetricsBucket[Key] };

function emptyTotals(): MutableTotals { return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheEligibleInputTokens: 0, cacheObservedRequests: 0, cacheHitRate: null, streamRequests: 0, errors: 0, errorRate: 0, averageLatencyMs: 0 }; }

function addEvent(target: MutableTotals, event: UsageEvent): void {
  target.requests += 1;
  target.inputTokens += event.inputTokens ?? 0;
  target.outputTokens += event.outputTokens ?? 0;
  target.totalTokens += totalForEvent(event);
  target.cacheReadTokens += event.cacheReadTokens ?? 0;
  target.cacheWriteTokens += event.cacheWriteTokens ?? 0;
  target.reasoningTokens += event.reasoningTokens ?? 0;
  if (event.cacheReadTokens !== null && event.cacheReadTokens !== undefined || event.cacheWriteTokens !== null && event.cacheWriteTokens !== undefined) {
    target.cacheObservedRequests += 1;
    target.cacheEligibleInputTokens += cacheEligibleInput(event);
  }
  if (event.stream) target.streamRequests += 1;
  if (event.status === null || event.status >= 400) target.errors += 1;
  target.averageLatencyMs += event.durationMs;
}

function addBucket(map: Map<string, MetricsBucket>, key: string, event: UsageEvent, labels: { provider?: string; model?: string } = {}): void {
  const current = map.get(key);
  const bucket: MetricsBucket = current ?? {
    key,
    ...emptyTotals(),
    ...(labels.provider ? { provider: labels.provider } : {}),
    ...(labels.model ? { model: labels.model } : {}),
  };
  addEvent(bucket as MutableBucket, event);
  const mutable = bucket as MutableBucket;
  if (event.completionSource) {
    if (!mutable.completionSource) mutable.completionSource = event.completionSource;
    else if (mutable.completionSource !== event.completionSource) mutable.completionSource = 'mixed';
  }
  map.set(key, bucket);
}

function finalizeTotals(target: MutableTotals): void {
  target.errorRate = target.requests === 0 ? 0 : target.errors / target.requests;
  target.cacheHitRate = target.cacheEligibleInputTokens > 0 ? Math.min(1, Math.max(0, target.cacheReadTokens / target.cacheEligibleInputTokens)) : null;
  target.averageLatencyMs = target.requests === 0 ? 0 : Math.round(target.averageLatencyMs / target.requests);
}

function normalizeEvent(event: UsageEvent): UsageEvent {
  const endpointHost = event.endpointHost?.toLowerCase().replace(/\.$/u, '') ?? null;
  const provider = providerFromHost(endpointHost, event.provider);
  const completionSource = event.completionSource ?? sourceFromLegacyEvent(event, endpointHost);
  return { ...event, endpointHost, provider, completionSource };
}

function providerFromHost(host: string | null, fallback: string): string {
  if (!host) return fallback === 'google' || fallback === 'openai' || fallback === 'anthropic' ? fallback : 'unknown';
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'generativelanguage.googleapis.com' || host === 'aiplatform.googleapis.com' || host.endsWith('.aiplatform.googleapis.com')) return 'google';
  return host;
}

function sourceFromLegacyEvent(event: UsageEvent, host: string | null): string | null {
  if (event.provider === 'google' || event.provider === 'openai' || event.provider === 'anthropic') return event.provider;
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'generativelanguage.googleapis.com' || host === 'aiplatform.googleapis.com' || host?.endsWith('.aiplatform.googleapis.com')) return 'google';
  return null;
}

function cacheEligibleInput(event: UsageEvent): number {
  const input = event.inputTokens ?? 0;
  const source = event.completionSource ?? (event.provider === 'anthropic' ? 'anthropic' : null);
  // Anthropic reports input_tokens exclusive of cache read/write tokens.
  return source === 'anthropic' ? input + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0) : input;
}

function totalForEvent(event: UsageEvent): number {
  if (event.totalTokens !== null && event.totalTokens !== undefined) return event.totalTokens;
  const base = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
  const source = event.completionSource ?? (event.provider === 'anthropic' ? 'anthropic' : null);
  return source === 'anthropic' ? base + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0) : base;
}
