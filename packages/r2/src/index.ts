import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import type { BackupManifest, R2Config, R2Object } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const R2_STATE_FILE = 'r2-config.json';
const R2_SCHEMA_VERSION = 1 as const;
const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
const MULTIPART_PART_BYTES = 64 * 1024 * 1024;
const MASKED_SECRET = '********';

interface StoredR2Config {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly bucket: string | null;
  readonly accountId: string | null;
  readonly accessKeyId: string | null;
  readonly secretAccessKey: string | null;
  readonly includeSecrets: boolean;
  readonly localIntervalMinutes: number;
  readonly r2IntervalHours: number;
  readonly fullIntervalDays: number;
  readonly maxBackups: number;
  readonly retentionDays: number | null;
  readonly lastUploadAt: string | null;
  readonly lastFingerprint: string | null;
  readonly estimatedBytes: number;
}

export interface R2ManagerOptions {
  readonly paths: PlatformPaths;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly logger?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

export interface R2UpdateInput {
  readonly enabled?: boolean;
  readonly endpoint?: string | null;
  readonly bucket?: string | null;
  readonly accountId?: string | null;
  readonly accessKeyId?: string | null;
  readonly secretAccessKey?: string | null;
  readonly includeSecrets?: boolean;
  readonly localIntervalMinutes?: number;
  readonly r2IntervalHours?: number;
  readonly fullIntervalDays?: number;
  readonly maxBackups?: number;
  readonly retentionDays?: number | null;
}

export interface R2UploadResult {
  readonly object: R2Object;
  readonly manifestObject: R2Object;
  readonly estimatedBytes: number;
}

export interface R2ConnectionResult {
  readonly ok: true;
  readonly objectCount: number;
  readonly totalBytes: number;
}

interface R2Credentials {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface S3ObjectRecord {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModified: string | null;
  readonly etag: string | null;
}

export class R2Error extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class R2HttpError extends R2Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super('r2_request_failed', message);
    this.status = status;
  }
}

export class R2Manager {
  readonly paths: PlatformPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly logger: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private configState: StoredR2Config | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: R2ManagerOptions) {
    this.paths = options.paths;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(line));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async getConfig(): Promise<R2Config> {
    return this.toPublic(await this.load());
  }

  public async update(input: R2UpdateInput): Promise<R2Config> {
    const current = await this.load();
    const next: StoredR2Config = {
      ...current,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.endpoint !== undefined ? { endpoint: normalizeNullable(input.endpoint) } : {}),
      ...(input.bucket !== undefined ? { bucket: normalizeNullable(input.bucket) } : {}),
      ...(input.accountId !== undefined ? { accountId: normalizeNullable(input.accountId) } : {}),
      ...(input.accessKeyId !== undefined ? { accessKeyId: preserveSecret(input.accessKeyId, current.accessKeyId) } : {}),
      ...(input.secretAccessKey !== undefined ? { secretAccessKey: preserveSecret(input.secretAccessKey, current.secretAccessKey) } : {}),
      ...(input.includeSecrets !== undefined ? { includeSecrets: input.includeSecrets } : {}),
      ...(input.localIntervalMinutes !== undefined ? { localIntervalMinutes: integerInRange(input.localIntervalMinutes, 1, 7 * 24 * 60, 'local interval') } : {}),
      ...(input.r2IntervalHours !== undefined ? { r2IntervalHours: integerInRange(input.r2IntervalHours, 1, 30 * 24, 'R2 interval') } : {}),
      ...(input.fullIntervalDays !== undefined ? { fullIntervalDays: integerInRange(input.fullIntervalDays, 1, 365, 'full backup interval') } : {}),
      ...(input.maxBackups !== undefined ? { maxBackups: integerInRange(input.maxBackups, 1, 1000, 'retention count') } : {}),
      ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays === null ? null : integerInRange(input.retentionDays, 1, 3650, 'retention days') } : {}),
    };
    validateStoredConfig(next);
    await this.save(next);
    return this.toPublic(next);
  }

  public async testConnection(): Promise<R2ConnectionResult> {
    const config = await this.load();
    const client = this.client(config);
    const objects = await client.listObjects(this.prefix(), 1000);
    return { ok: true, objectCount: objects.length, totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0) };
  }

  public async listObjects(): Promise<R2Object[]> {
    const config = await this.load();
    const objects = await this.client(config).listObjects(this.prefix(), 1000);
    return objects.map(toPublicObject);
  }

  public async uploadArchive(archivePath: string, manifest: BackupManifest, fingerprint: string | null = null, allowSecrets = false): Promise<R2UploadResult> {
    const config = await this.load();
    if (manifest.includesSecrets && (!allowSecrets || !config.includeSecrets)) {
      throw new R2Error('secrets_confirmation_required', 'R2 upload of secrets.json requires explicit confirmation and R2 permission');
    }
    const details = await stat(archivePath);
    const client = this.client(config);
    const key = `${this.prefix()}${manifest.id}.zip`;
    await client.uploadFile(key, archivePath, details.size, 'application/zip');
    const manifestKey = `${this.prefix()}${manifest.id}.manifest.json`;
    const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await client.putObject(manifestKey, manifestBody, 'application/json');
    const usage = await this.applyRetention(config, client);
    const uploadedAt = this.now().toISOString();
    await this.save({ ...config, lastUploadAt: uploadedAt, lastFingerprint: fingerprint, estimatedBytes: usage.totalBytes });
    this.logger(`[r2] uploaded ${manifest.name} (${details.size} bytes)`);
    const objects = usage.objects;
    const object = objects.find((item) => item.key === key) ?? { key, sizeBytes: details.size, lastModified: uploadedAt, etag: null };
    const manifestObject = objects.find((item) => item.key === manifestKey) ?? { key: manifestKey, sizeBytes: manifestBody.byteLength, lastModified: uploadedAt, etag: null };
    return { object: toPublicObject(object), manifestObject: toPublicObject(manifestObject), estimatedBytes: usage.totalBytes };
  }

  public async deleteObject(key: string): Promise<void> {
    if (!key.startsWith(this.prefix()) || key.includes('..')) throw new R2Error('invalid_object_key', 'The R2 object key is invalid');
    const config = await this.load();
    await this.client(config).deleteObject(key);
    const objects = await this.client(config).listObjects(this.prefix(), 1000);
    await this.save({ ...(await this.load()), estimatedBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0) });
  }

  public async markFingerprint(fingerprint: string): Promise<void> {
    const config = await this.load();
    await this.save({ ...config, lastFingerprint: fingerprint });
  }

  private async applyRetention(config: StoredR2Config, client: R2Client): Promise<{ objects: S3ObjectRecord[]; totalBytes: number }> {
    let objects = await client.listObjects(this.prefix(), 1000);
    const now = this.now().getTime();
    const candidates = objects.filter((object) => object.key.endsWith('.zip')).sort((left, right) => (right.lastModified ?? '').localeCompare(left.lastModified ?? ''));
    const remove = new Set<string>();
    candidates.forEach((object, index) => {
      const ageExpired = config.retentionDays !== null && object.lastModified !== null && now - Date.parse(object.lastModified) > config.retentionDays * 24 * 60 * 60 * 1000;
      if (index >= config.maxBackups || ageExpired) {
        remove.add(object.key);
        remove.add(object.key.replace(/\.zip$/u, '.manifest.json'));
      }
    });
    for (const key of remove) {
      await client.deleteObject(key);
      objects = objects.filter((object) => object.key !== key);
    }
    return { objects, totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0) };
  }

  private client(config: StoredR2Config): R2Client {
    const credentials = toCredentials(config);
    return new R2Client(credentials, this.fetchImpl);
  }

  private prefix(): string {
    return 'sillytavern-manager/';
  }

  private toPublic(config: StoredR2Config): R2Config {
    return {
      enabled: config.enabled,
      endpoint: config.endpoint,
      bucket: config.bucket,
      accountId: config.accountId,
      configured: Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey),
      lastUploadAt: config.lastUploadAt,
      accessKeyIdMasked: config.accessKeyId ? maskSecret(config.accessKeyId) : null,
      secretAccessKeyConfigured: Boolean(config.secretAccessKey),
      includeSecrets: config.includeSecrets,
      schedule: {
        localIntervalMinutes: config.localIntervalMinutes,
        r2IntervalHours: config.r2IntervalHours,
        fullIntervalDays: config.fullIntervalDays,
      },
      retention: { maxBackups: config.maxBackups, retentionDays: config.retentionDays },
      lastFingerprint: config.lastFingerprint,
      estimatedBytes: config.estimatedBytes,
    };
  }

  private async load(): Promise<StoredR2Config> {
    if (this.configState) return this.configState;
    await mkdir(this.paths.state, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, R2_STATE_FILE), 'utf8'));
      this.configState = parseStoredConfig(parsed);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      const fromEnvironment: StoredR2Config = {
        schemaVersion: R2_SCHEMA_VERSION,
        enabled: Boolean(this.env.STM_R2_ENDPOINT && this.env.STM_R2_BUCKET && this.env.STM_R2_ACCESS_KEY_ID && this.env.STM_R2_SECRET_ACCESS_KEY),
        endpoint: nullableEnvironment(this.env.STM_R2_ENDPOINT),
        bucket: nullableEnvironment(this.env.STM_R2_BUCKET),
        accountId: nullableEnvironment(this.env.STM_R2_ACCOUNT_ID),
        accessKeyId: nullableEnvironment(this.env.STM_R2_ACCESS_KEY_ID),
        secretAccessKey: nullableEnvironment(this.env.STM_R2_SECRET_ACCESS_KEY),
        includeSecrets: false,
        localIntervalMinutes: 60,
        r2IntervalHours: 24,
        fullIntervalDays: 7,
        maxBackups: 7,
        retentionDays: 30,
        lastUploadAt: null,
        lastFingerprint: null,
        estimatedBytes: 0,
      };
      validateStoredConfig(fromEnvironment);
      await this.save(fromEnvironment);
    }
    if (!this.configState) throw new Error('R2 configuration could not be loaded');
    return this.configState;
  }

  private async save(config: StoredR2Config): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, R2_STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.configState = config;
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }
}

class R2Client {
  private readonly region = 'auto';
  private readonly service = 's3';
  public constructor(private readonly credentials: R2Credentials, private readonly fetchImpl: typeof fetch) {}

  public async listObjects(prefix: string, maxKeys: number): Promise<S3ObjectRecord[]> {
    const response = await this.request('GET', '', null, new URLSearchParams([['list-type', '2'], ['prefix', prefix], ['max-keys', String(maxKeys)]]));
    const body = await response.text();
    const items: S3ObjectRecord[] = [];
    for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
      const content = match[1] ?? '';
      const key = decodeXml(readXmlTag(content, 'Key') ?? '');
      if (!key) continue;
      const size = Number(readXmlTag(content, 'Size') ?? 0);
      items.push({ key, sizeBytes: Number.isFinite(size) ? size : 0, lastModified: readXmlTag(content, 'LastModified'), etag: readXmlTag(content, 'ETag') });
    }
    return items;
  }

  public async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.request('PUT', key, body, undefined, { 'content-type': contentType, 'content-length': String(body.byteLength) });
  }

  public async uploadFile(key: string, path: string, sizeBytes: number, contentType: string): Promise<void> {
    if (sizeBytes < MULTIPART_THRESHOLD_BYTES) {
      const stream = createReadStream(path);
      try {
        await this.request('PUT', key, Readable.toWeb(stream) as unknown as BodyInit, undefined, { 'content-type': contentType, 'content-length': String(sizeBytes) });
      } finally {
        stream.destroy();
      }
      return;
    }
    const uploadId = await this.createMultipart(key, contentType);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    try {
      let partNumber = 1;
      for (let offset = 0; offset < sizeBytes; offset += MULTIPART_PART_BYTES) {
        const length = Math.min(MULTIPART_PART_BYTES, sizeBytes - offset);
        const stream = createReadStream(path, { start: offset, end: offset + length - 1 });
        try {
          const response = await this.request('PUT', key, Readable.toWeb(stream) as unknown as BodyInit, new URLSearchParams([['partNumber', String(partNumber)], ['uploadId', uploadId]]), { 'content-type': contentType, 'content-length': String(length) });
          const etag = response.headers.get('etag');
          if (!etag) throw new R2Error('r2_missing_etag', 'R2 did not return a multipart ETag');
          parts.push({ partNumber, etag });
        } finally {
          stream.destroy();
        }
        partNumber += 1;
      }
      await this.completeMultipart(key, uploadId, parts);
    } catch (error) {
      await this.abortMultipart(key, uploadId).catch(() => undefined);
      throw error;
    }
  }

  public async deleteObject(key: string): Promise<void> {
    await this.request('DELETE', key, null);
  }

  private async createMultipart(key: string, contentType: string): Promise<string> {
    const response = await this.request('POST', key, null, new URLSearchParams([['uploads', '']]), { 'content-type': contentType });
    const body = await response.text();
    const uploadId = readXmlTag(body, 'UploadId');
    if (!uploadId) throw new R2Error('r2_missing_upload_id', 'R2 did not return a multipart upload id');
    return decodeXml(uploadId);
  }

  private async completeMultipart(key: string, uploadId: string, parts: readonly { partNumber: number; etag: string }[]): Promise<void> {
    const body = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    await this.request('POST', key, Buffer.from(body, 'utf8'), new URLSearchParams([['uploadId', uploadId]]), { 'content-type': 'application/xml' });
  }

  private async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.request('DELETE', key, null, new URLSearchParams([['uploadId', uploadId]]));
  }

  private async request(method: string, key: string, body: BodyInit | Uint8Array | null, query?: URLSearchParams, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const url = objectUrl(this.credentials.endpoint, this.credentials.bucket, key, query);
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const amzDate = formatAmzDate(new Date());
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders };
    const { authorization } = signRequest({ method, url, headers, payloadHash, accessKeyId: this.credentials.accessKeyId, secretAccessKey: this.credentials.secretAccessKey, region: this.region, service: this.service });
    headers.authorization = authorization;
    const init = { method, headers, ...(body === null ? {} : { body: body as BodyInit }), duplex: 'half' } as RequestInit & { duplex: 'half' };
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      const message = (await response.text()).slice(0, 500);
      throw new R2HttpError(response.status, `R2 request failed (${response.status}): ${message || response.statusText}`);
    }
    return response;
  }
}

function signRequest(options: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; accessKeyId: string; secretAccessKey: string; region: string; service: string }): { authorization: string } {
  const normalizedHeaders = Object.entries(options.headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/gu, ' ')] as const).sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = normalizedHeaders.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = normalizedHeaders.map(([name]) => name).join(';');
  const canonicalQuery = canonicalQueryString(options.url.searchParams);
  const canonicalRequest = [options.method, options.url.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, options.payloadHash].join('\n');
  const date = options.headers['x-amz-date']?.slice(0, 8) ?? formatAmzDate(new Date()).slice(0, 8);
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${options.headers['x-amz-date']}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmacDigest(`AWS4${options.secretAccessKey}`, date);
  const regionKey = hmacDigest(dateKey, options.region);
  const serviceKey = hmacDigest(regionKey, options.service);
  const signingKey = hmacDigest(serviceKey, 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  return { authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

function objectUrl(endpoint: string, bucket: string, key: string, query?: URLSearchParams): URL {
  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  const encodedKey = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const url = new URL(`${base}/${encodeURIComponent(bucket)}${encodedKey ? `/${encodedKey}` : ''}`);
  if (query) url.search = canonicalQueryString(query);
  return url;
}

function canonicalQueryString(query: URLSearchParams): string {
  return [...query.entries()].map(([key, value]) => [rfc3986(key), rfc3986(value)] as const).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}=${value}`).join('&');
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacDigest(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return hmacDigest(key, value).toString('hex');
}

function toCredentials(config: StoredR2Config): R2Credentials {
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new R2Error('r2_not_configured', 'Configure the R2 endpoint, bucket, access key, and secret key first');
  return { endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
}

function validateStoredConfig(config: StoredR2Config): void {
  if (config.endpoint !== null) {
    let parsed: URL;
    try { parsed = new URL(config.endpoint); } catch { throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must be a valid HTTPS URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must use HTTPS');
    if (parsed.search || parsed.hash) throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must not contain a query or fragment');
  }
  if (config.bucket !== null && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket)) throw new R2Error('invalid_r2_bucket', 'R2 bucket name is invalid');
}

function parseStoredConfig(value: unknown): StoredR2Config {
  if (!isRecord(value) || value.schemaVersion !== R2_SCHEMA_VERSION) throw new Error('Unsupported R2 configuration schema');
  const config = { ...defaultStoredConfig(), ...value, schemaVersion: R2_SCHEMA_VERSION } as StoredR2Config;
  validateStoredConfig(config);
  return config;
}

function defaultStoredConfig(): StoredR2Config {
  return { schemaVersion: R2_SCHEMA_VERSION, enabled: false, endpoint: null, bucket: null, accountId: null, accessKeyId: null, secretAccessKey: null, includeSecrets: false, localIntervalMinutes: 60, r2IntervalHours: 24, fullIntervalDays: 7, maxBackups: 7, retentionDays: 30, lastUploadAt: null, lastFingerprint: null, estimatedBytes: 0 };
}

function normalizeNullable(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function preserveSecret(value: string | null, previous: string | null): string | null {
  if (value === MASKED_SECRET) return previous;
  return normalizeNullable(value);
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new R2Error('invalid_r2_schedule', `The ${label} is out of range`);
  return value;
}

function maskSecret(value: string): string {
  if (value.length <= 4) return MASKED_SECRET;
  return `${value.slice(0, 2)}${MASKED_SECRET}${value.slice(-2)}`;
}

function toPublicObject(object: S3ObjectRecord): R2Object {
  return { key: object.key, sizeBytes: object.sizeBytes, lastModified: object.lastModified, etag: object.etag };
}

function readXmlTag(value: string, tag: string): string | null {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(value)?.[1] ?? null;
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function nullableEnvironment(value: string | undefined): string | null {
  return value?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
