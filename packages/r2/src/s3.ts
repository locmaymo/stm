import { createHash, createHmac } from 'node:crypto';
import { R2HttpError, type Billing, type ObjectRecord, type ObjectStore } from './store.js';

export interface R2Credentials {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The bucket over the S3 API, signed with an access key and secret (SigV4). */
export class S3ObjectStore implements ObjectStore {
  private readonly region = 'auto';
  private readonly service = 's3';

  public constructor(
    private readonly credentials: R2Credentials,
    private readonly fetchImpl: typeof fetch,
    /** Told about every request that Cloudflare charges for, as it is made. */
    private readonly onRequest: (billing: Billing) => void,
  ) {}

  public async listObjects(prefix: string, maxKeys: number, cursor?: string): Promise<{ objects: ObjectRecord[]; cursor: string | undefined }> {
    const query = new URLSearchParams([['list-type', '2'], ['prefix', prefix], ['max-keys', String(maxKeys)]]);
    if (cursor) query.set('continuation-token', cursor);
    const response = await this.request('GET', '', null, query, {}, 'charged');
    const body = await response.text();
    const objects: ObjectRecord[] = [];
    for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
      const content = match[1] ?? '';
      const key = decodeXml(readXmlTag(content, 'Key') ?? '');
      if (!key) continue;
      const size = Number(readXmlTag(content, 'Size') ?? 0);
      objects.push({ key, sizeBytes: Number.isFinite(size) ? size : 0, lastModified: readXmlTag(content, 'LastModified'), etag: readXmlTag(content, 'ETag') });
    }
    // A store of tens of thousands of chunks does not fit one page, and a
    // listing that stopped at the first one made every chunk past it look
    // absent - which would have meant uploading them all again, every time.
    const truncated = readXmlTag(body, 'IsTruncated') === 'true';
    const next = readXmlTag(body, 'NextContinuationToken');
    return { objects, cursor: truncated && next ? decodeXml(next) : undefined };
  }

  public async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.request('PUT', key, body, undefined, { 'content-type': contentType, 'content-length': String(body.byteLength) }, 'charged');
  }

  public async getObject(key: string): Promise<Buffer> {
    const response = await this.request('GET', key, null, undefined, {}, 'read');
    return Buffer.from(await response.arrayBuffer());
  }

  public async deleteObject(key: string): Promise<void> {
    await this.request('DELETE', key, null, undefined, {}, 'free');
  }

  private async request(method: string, key: string, body: BodyInit | Uint8Array | null, query?: URLSearchParams, extraHeaders: Record<string, string> = {}, billing: Billing = 'read'): Promise<Response> {
    const url = objectUrl(this.credentials.endpoint, this.credentials.bucket, key, query);
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const amzDate = formatAmzDate(new Date());
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders };
    const { authorization } = signRequest({ method, url, headers, payloadHash, accessKeyId: this.credentials.accessKeyId, secretAccessKey: this.credentials.secretAccessKey, region: this.region, service: this.service });
    headers.authorization = authorization;
    const init = { method, headers, ...(body === null ? {} : { body: body as BodyInit }), duplex: 'half' } as RequestInit & { duplex: 'half' };
    this.onRequest(billing);
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

function readXmlTag(value: string, tag: string): string | null {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(value)?.[1] ?? null;
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}
