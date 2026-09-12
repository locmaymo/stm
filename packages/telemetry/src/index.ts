import { createHmac, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PlatformKind, TelemetryBatch, TelemetryEnvelope, UsageEvent } from '../../contracts/src/index.js';
import { isUsageEvent } from '../../instrumentation/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const OUTBOX_NAME = 'telemetry-outbox.jsonl';
const CURSOR_NAME = 'telemetry-cursor.json';
const MAX_BATCH_EVENTS = 100;
const MAX_OUTBOX_LINES = 1_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://stm-telemetry.phamloc.top/v1/telemetry';
export const DEFAULT_TELEMETRY_ENROLLMENT_ENDPOINT = 'https://stm-telemetry.phamloc.top/v1/enroll';

export interface TelemetryTransportOptions {
  readonly paths: PlatformPaths;
  readonly metricsFile: string;
  readonly installId: string;
  readonly platform: PlatformKind;
  readonly appVersion?: string;
  readonly endpoint?: string;
  readonly enrollmentEndpoint?: string;
  readonly enrollmentToken?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: (line: string) => void;
  readonly pollIntervalMs?: number;
  readonly flushIntervalMs?: number;
}

/**
 * Tails the local allowlisted metrics file and asynchronously delivers batches.
 * A missing endpoint leaves the durable outbox untouched; network failures never
 * escape into the manager request path.
 */
export class TelemetryTransport {
  private readonly paths: PlatformPaths;
  private readonly metricsFile: string;
  private readonly installId: string;
  private readonly platform: PlatformKind;
  private readonly appVersion: string;
  private readonly endpoint: string | null;
  private readonly enrollmentEndpoint: string | null;
  private readonly enrollmentToken: string | null;
  private readonly request: typeof globalThis.fetch;
  private readonly logger: (line: string) => void;
  private readonly pollIntervalMs: number;
  private readonly flushIntervalMs: number;
  private readonly signingKeyPath: string;
  private metricsOffset = 0;
  private remainder = '';
  private pending: UsageEvent[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private closed = false;
  private signingKey: string | null = null;
  private startupFlush: Promise<void> = Promise.resolve();

  public constructor(options: TelemetryTransportOptions) {
    this.paths = options.paths;
    this.metricsFile = options.metricsFile;
    this.installId = options.installId;
    this.platform = options.platform;
    this.appVersion = options.appVersion ?? '0.1.0';
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.enrollmentEndpoint = normalizeEndpoint(options.enrollmentEndpoint) ?? deriveEnrollmentEndpoint(this.endpoint);
    this.enrollmentToken = options.enrollmentToken?.trim() || null;
    this.request = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? (() => undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 10_000;
    this.signingKeyPath = join(this.paths.outbox, 'telemetry-identity.json');
  }

  public get outboxPath(): string { return join(this.paths.outbox, OUTBOX_NAME); }

  public async start(): Promise<void> {
    await mkdir(this.paths.outbox, { recursive: true });
    await this.loadSigningKey();
    await this.loadCursor();
    await this.poll();
    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
    this.flushTimer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    this.pollTimer.unref();
    this.flushTimer.unref();
    // Network enrollment/delivery is deliberately detached from manager
    // startup. A slow or unavailable receiver must never delay the UI.
    this.startupFlush = this.flush();
  }

  public async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.pollTimer = null;
    this.flushTimer = null;
    await this.poll();
    this.closed = true;
    await this.startupFlush;
    await this.flush();
  }

  /** Test and operational hook for forcing a bounded read of new metrics. */
  public async pollNow(): Promise<void> { await this.poll(); }

  /** Test and operational hook for forcing queueing and delivery. */
  public async flushNow(): Promise<void> { await this.startupFlush; await this.flush(); }

  private async poll(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      let handle;
      try { handle = await open(this.metricsFile, 'r'); } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
        return;
      }
      const statistics = await handle.stat();
      if (this.metricsOffset > statistics.size) {
        this.metricsOffset = 0;
        this.remainder = '';
      }
      const startOffset = this.metricsOffset;
      const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(0, statistics.size - startOffset)));
      const { bytesRead } = buffer.byteLength === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.byteLength, startOffset);
      await handle.close();
      const chunk = buffer.subarray(0, bytesRead).toString('utf8');
      const input = `${this.remainder}${chunk}`;
      const lines = input.split(/\r?\n/u);
      this.remainder = lines.pop() ?? '';
      // The file offset includes an incomplete trailing line; that line is
      // retained separately and combined with only newly appended bytes next
      // time, preventing duplicate JSONL records.
      this.metricsOffset = startOffset + bytesRead;
      for (const line of lines) {
        if (!line || line.length > 16 * 1024) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isUsageEvent(parsed)) this.pending.push(sanitizeEvent(parsed));
        } catch {
          // An interrupted JSONL append is ignored until a complete line exists.
        }
      }
      // Persist the cursor only after the events have reached the durable
      // outbox. A crash between these operations must not lose telemetry.
      await this.enqueuePending();
      await this.saveCursor();
    } catch (error: unknown) {
      this.logger(`[telemetry] metrics poll skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.busy = false;
    }
  }

  private async flush(): Promise<void> {
    if (this.busy || this.closed && this.pending.length === 0) return;
    this.busy = true;
    try {
      await this.enqueuePending();
      await this.deliver();
    } catch (error: unknown) {
      this.logger(`[telemetry] delivery skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.busy = false;
    }
  }

  private async enqueuePending(): Promise<void> {
    if (this.pending.length === 0) return;
    const batches: TelemetryBatch[] = [];
    for (let index = 0; index < this.pending.length; index += MAX_BATCH_EVENTS) {
      batches.push({
        schemaVersion: 1,
        installId: this.installId,
        appVersion: this.appVersion,
        platform: this.platform,
        sentAt: new Date().toISOString(),
        events: this.pending.slice(index, index + MAX_BATCH_EVENTS),
      });
    }
    await mkdir(dirname(this.outboxPath), { recursive: true });
    await appendFile(this.outboxPath, batches.map((batch) => `${JSON.stringify(batch)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
    this.pending = [];
    await pruneOutbox(this.outboxPath);
  }

  private async deliver(): Promise<void> {
    if (!this.endpoint || !this.request) return;
    const signingKey = await this.ensureSigningKey();
    if (!signingKey) return;
    let lines: string[];
    try { lines = (await readFile(this.outboxPath, 'utf8')).split(/\r?\n/u).filter(Boolean); } catch (error: unknown) {
      if (isNotFound(error)) return;
      throw error;
    }
    const remaining: string[] = [];
    for (const line of lines) {
      let batch: TelemetryBatch;
      try { batch = parseBatch(JSON.parse(line)); } catch { continue; }
      try {
        const unsigned = {
          schemaVersion: 1 as const,
          installId: this.installId,
          sentAt: new Date().toISOString(),
          nonce: randomUUID(),
          batch,
        };
        const envelope: TelemetryEnvelope = { ...unsigned, signature: signEnvelope(unsigned, signingKey) };
        const response = await this.request(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`endpoint returned ${response.status}`);
      } catch (error: unknown) {
        remaining.push(line);
        this.logger(`[telemetry] endpoint unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
        break;
      }
    }
    const delivered = lines.length - remaining.length;
    if (delivered === lines.length) {
      await writeFile(this.outboxPath, '', { encoding: 'utf8', mode: 0o600 });
      return;
    }
    if (delivered > 0) await atomicWrite(this.outboxPath, `${remaining.join('\n')}\n`);
  }

  private async loadSigningKey(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.signingKeyPath, 'utf8'));
      if (isRecord(value) && value.installId === this.installId && typeof value.key === 'string' && isSigningKey(value.key)) this.signingKey = value.key;
    } catch (error: unknown) {
      if (!isNotFound(error)) this.logger('[telemetry] signing key reset');
    }
  }

  private async ensureSigningKey(): Promise<string | null> {
    if (this.signingKey) return this.signingKey;
    if (!this.enrollmentEndpoint || !this.request) return null;
    const response = await this.request(this.enrollmentEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, installId: this.installId, platform: this.platform, appVersion: this.appVersion, ...(this.enrollmentToken ? { enrollmentToken: this.enrollmentToken } : {}) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`enrollment returned ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.key !== 'string' || !isSigningKey(body.key)) throw new Error('enrollment returned an invalid signing key');
    await atomicWrite(this.signingKeyPath, `${JSON.stringify({ schemaVersion: 1, installId: this.installId, key: body.key })}\n`);
    this.signingKey = body.key;
    return this.signingKey;
  }

  private async loadCursor(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.outbox, CURSOR_NAME), 'utf8'));
      if (isRecord(parsed) && typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0) this.metricsOffset = parsed.offset;
    } catch (error: unknown) {
      if (!isNotFound(error)) this.logger('[telemetry] cursor reset');
    }
  }

  private async saveCursor(): Promise<void> {
    await atomicWrite(join(this.paths.outbox, CURSOR_NAME), `${JSON.stringify({ offset: this.metricsOffset })}\n`);
  }
}

function sanitizeEvent(event: UsageEvent): UsageEvent {
  return {
    schemaVersion: 1,
    timestamp: validTimestamp(event.timestamp) ? event.timestamp : new Date().toISOString(),
    provider: safeText(event.provider, 'unknown'),
    completionSource: event.completionSource == null ? null : safeText(event.completionSource, 'unknown'),
    model: event.model == null ? null : safeText(event.model, ''),
    endpointHost: sanitizeHost(event.endpointHost),
    stream: event.stream === true,
    maxTokens: safeNumber(event.maxTokens),
    inputTokens: safeNumber(event.inputTokens),
    outputTokens: safeNumber(event.outputTokens),
    totalTokens: safeNumber(event.totalTokens),
    cacheReadTokens: safeNumber(event.cacheReadTokens),
    cacheWriteTokens: safeNumber(event.cacheWriteTokens),
    reasoningTokens: safeNumber(event.reasoningTokens),
    status: safeInteger(event.status),
    durationMs: Math.max(0, Math.min(86_400_000, safeNumber(event.durationMs) ?? 0)),
  };
}

function parseBatch(value: unknown): TelemetryBatch {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.installId !== 'string' || typeof value.appVersion !== 'string' || typeof value.platform !== 'string' || typeof value.sentAt !== 'string' || !Array.isArray(value.events) || value.events.length === 0) throw new Error('invalid telemetry batch');
  const events = value.events.filter(isUsageEvent).map(sanitizeEvent);
  if (events.length !== value.events.length) throw new Error('invalid telemetry event');
  return { schemaVersion: 1, installId: value.installId.slice(0, 128), appVersion: value.appVersion.slice(0, 64), platform: value.platform as PlatformKind, sentAt: value.sentAt, events };
}

async function pruneOutbox(path: string): Promise<void> {
  let lines: string[];
  try { lines = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean); } catch { return; }
  const cutoff = Date.now() - RETENTION_MS;
  const kept = lines.filter((line) => {
    try { const value = JSON.parse(line) as { sentAt?: unknown }; return typeof value.sentAt !== 'string' || Date.parse(value.sentAt) >= cutoff; } catch { return false; }
  }).slice(-MAX_OUTBOX_LINES);
  if (kept.length !== lines.length) await atomicWrite(path, kept.length ? `${kept.join('\n')}\n` : '');
}

function normalizeEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch { return null; }
}

function deriveEnrollmentEndpoint(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint);
    const path = parsed.pathname.replace(/\/$/u, '');
    parsed.pathname = path.endsWith('/telemetry') ? `${path.slice(0, -'/telemetry'.length)}/enroll` : `${path}/enroll`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch { return null; }
}

function isSigningKey(value: string): boolean { return /^[A-Za-z0-9_-]{43,128}$/u.test(value); }
function signEnvelope(value: Omit<TelemetryEnvelope, 'signature'>, key: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64url')).update(JSON.stringify(value), 'utf8').digest('base64url');
}

function sanitizeHost(value: string | null): string | null {
  if (!value || /[/?#\\]/u.test(value)) return null;
  const host = value.toLowerCase().replace(/:\d+$/u, '').replace(/\.$/u, '');
  return /^[a-z0-9](?:[a-z0-9.-]{0,252}[a-z0-9])?$/u.test(host) ? host : null;
}

function safeText(value: string, fallback: string): string {
  const normalized = value.normalize('NFC').replace(/[\r\n]/gu, '').slice(0, 256);
  return normalized || fallback;
}

function safeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : null;
}

function safeInteger(value: number | null | undefined): number | null {
  const number = safeNumber(value);
  return number === null ? null : Math.round(number);
}

function validTimestamp(value: string): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isNotFound(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT'; }

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
