import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagerNotification } from '../../../packages/contracts/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';
import { renderNotification, type NotificationLocale } from './notifications.js';

/*
 * Web Push, from the sending side: RFC 8030 to deliver, RFC 8291 to encrypt
 * the message so only the browser can read it, and RFC 8292 (VAPID) to say
 * which server sent it.
 *
 * Written against `node:crypto` rather than pulled in as a dependency. It is
 * about a hundred lines of well-specified work, and each of those lines is one
 * a reader can check against the RFCs.
 */

const KEYS_FILE = 'push-keys.json';
const SUBSCRIPTIONS_FILE = 'push-subscriptions.json';
/** A browser that stopped answering is dropped after this many failures in a row. */
const MAX_FAILURES = 5;
const MAX_SUBSCRIPTIONS = 20;
/** Who to contact about this sender, as VAPID asks; the project's own site. */
const VAPID_SUBJECT = 'https://stm.locmaymo.top';
/** How long a push service keeps a message for a browser that is offline. */
const TTL_SECONDS = 24 * 60 * 60;

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  /** The browser's public key, base64url, uncompressed P-256. */
  readonly p256dh: string;
  /** The browser's auth secret, base64url, 16 bytes. */
  readonly auth: string;
  readonly locale: NotificationLocale;
  readonly createdAt: string;
  readonly failures: number;
}

interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** A push as the service worker reads it. */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly tag: string;
  readonly level: string;
}

function base64url(bytes: Buffer): string { return bytes.toString('base64url'); }
function fromBase64url(value: string): Buffer { return Buffer.from(value, 'base64url'); }

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Encrypt one message for one browser, as RFC 8291 describes.
 *
 * `serverKeys` and `salt` are only passed by the test that checks this
 * against the RFC's own example; everywhere else both are fresh each time.
 */
export function encryptPayload(payload: Buffer, browserPublicKey: Buffer, authSecret: Buffer, serverKeys?: { readonly privateKey: Buffer; readonly publicKey: Buffer }, salt: Buffer = randomBytes(16)): Buffer {
  const ecdh = createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(serverKeys.privateKey);
  else ecdh.generateKeys();
  const serverPublic = serverKeys?.publicKey ?? ecdh.getPublicKey();
  const shared = ecdh.computeSecret(browserPublicKey);
  // HKDF with the auth secret, then again with the salt; each expand is one
  // HMAC because every output here is at most 32 bytes.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), browserPublicKey, serverPublic, Buffer.from([1])]);
  const ikm = hmac(hmac(authSecret, shared), keyInfo);
  const prk = hmac(salt, ikm);
  const contentKey = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'utf8'), Buffer.from([1])])).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  // One record, so it ends with the last-record delimiter and carries no padding.
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, encrypted]);
}

/** The VAPID header value for one push service. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now: Date): string {
  const audience = new URL(endpoint).origin;
  const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60, sub: VAPID_SUBJECT })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}

function privateKeyObject(keys: VapidKeys): KeyObject {
  const publicKey = fromBase64url(keys.publicKey);
  return createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: base64url(publicKey.subarray(1, 33)), y: base64url(publicKey.subarray(33, 65)) },
  });
}

export interface WebPushOptions {
  readonly paths: PlatformPaths;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

/**
 * The browsers that asked to be told, and the telling.
 *
 * Each subscription remembers the language it was made in, because the
 * service worker shows the words it is sent and has nobody to ask.
 */
export class WebPush {
  private readonly paths: PlatformPaths;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private keys: VapidKeys | null = null;
  private subscriptions: PushSubscriptionRecord[] | null = null;
  private writing: Promise<void> = Promise.resolve();

  public constructor(options: WebPushOptions) {
    this.paths = options.paths;
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? (() => new Date());
  }

  /** This manager's public key, which a browser needs to subscribe. Made on first use. */
  public async publicKey(): Promise<string> {
    return (await this.loadKeys()).publicKey;
  }

  public async subscribe(input: { readonly endpoint: string; readonly p256dh: string; readonly auth: string; readonly locale: NotificationLocale }): Promise<void> {
    const list = (await this.loadSubscriptions()).filter((item) => item.endpoint !== input.endpoint);
    list.unshift({ ...input, createdAt: this.now().toISOString(), failures: 0 });
    this.subscriptions = list.slice(0, MAX_SUBSCRIPTIONS);
    await this.saveSubscriptions();
  }

  public async unsubscribe(endpoint: string): Promise<void> {
    const list = await this.loadSubscriptions();
    const kept = list.filter((item) => item.endpoint !== endpoint);
    if (kept.length === list.length) return;
    this.subscriptions = kept;
    await this.saveSubscriptions();
  }

  public async has(endpoint: string): Promise<boolean> {
    return (await this.loadSubscriptions()).some((item) => item.endpoint === endpoint);
  }

  /** Tell every subscribed browser. Never throws: a push that fails is a push not seen. */
  public async deliver(notification: ManagerNotification): Promise<void> {
    const list = await this.loadSubscriptions().catch(() => []);
    await Promise.all(list.map(async (subscription) => {
      const words = renderNotification(notification, subscription.locale);
      await this.send(subscription, { title: words.title, body: words.body, url: words.url, tag: words.tag, level: words.level }, notification.level === 'error' ? 'high' : 'normal');
    }));
  }

  /** One message to one browser; true when the push service took it. */
  public async send(subscription: PushSubscriptionRecord, message: PushMessage, urgency: 'normal' | 'high' = 'normal'): Promise<boolean> {
    let delivered = false;
    let gone = false;
    try {
      const keys = await this.loadKeys();
      const body = encryptPayload(Buffer.from(JSON.stringify(message), 'utf8'), fromBase64url(subscription.p256dh), fromBase64url(subscription.auth));
      const response = await this.fetcher(subscription.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(subscription.endpoint, keys, this.now()),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(TTL_SECONDS),
          urgency,
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(15_000),
      });
      await response.arrayBuffer().catch(() => undefined);
      delivered = response.ok;
      // The browser unsubscribed, or the push service forgot it.
      gone = response.status === 404 || response.status === 410;
    } catch {
      delivered = false;
    }
    await this.settle(subscription.endpoint, delivered, gone);
    return delivered;
  }

  private async settle(endpoint: string, delivered: boolean, gone: boolean): Promise<void> {
    const list = await this.loadSubscriptions();
    const next = list.flatMap((item) => {
      if (item.endpoint !== endpoint) return [item];
      if (gone) return [];
      const failures = delivered ? 0 : item.failures + 1;
      return failures >= MAX_FAILURES ? [] : [{ ...item, failures }];
    });
    this.subscriptions = next;
    await this.saveSubscriptions();
  }

  private async loadKeys(): Promise<VapidKeys> {
    if (this.keys) return this.keys;
    const path = join(this.paths.state, KEYS_FILE);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<VapidKeys>;
      if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
        this.keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        return this.keys;
      }
    } catch {
      // Made below. A manager whose keys are lost makes new ones, and every
      // browser has to subscribe again - which it does the next time the
      // console is opened with notifications on.
    }
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    this.keys = { publicKey: base64url(ecdh.getPublicKey()), privateKey: base64url(ecdh.getPrivateKey()) };
    await mkdir(this.paths.state, { recursive: true });
    await writeAtomic(path, `${JSON.stringify(this.keys)}\n`);
    return this.keys;
  }

  private async loadSubscriptions(): Promise<PushSubscriptionRecord[]> {
    if (this.subscriptions) return this.subscriptions;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, SUBSCRIPTIONS_FILE), 'utf8'));
      this.subscriptions = Array.isArray(parsed) ? parsed.filter(isSubscription) : [];
    } catch {
      this.subscriptions = [];
    }
    return this.subscriptions;
  }

  private async saveSubscriptions(): Promise<void> {
    const list = this.subscriptions ?? [];
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      await writeAtomic(join(this.paths.state, SUBSCRIPTIONS_FILE), `${JSON.stringify(list)}\n`);
    };
    const previous = this.writing;
    this.writing = previous.then(operation, operation);
    await this.writing;
  }
}

/** Whether a browser's subscription looks like one: an https endpoint and keys of the right size. */
export function validSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const keys = typeof record.keys === 'object' && record.keys !== null ? record.keys as Record<string, unknown> : null;
  if (typeof record.endpoint !== 'string' || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false;
  let url: URL;
  try { url = new URL(record.endpoint); } catch { return false; }
  return url.protocol === 'https:'
    && record.endpoint.length <= 2048
    && fromBase64url(keys.p256dh).length === 65
    && fromBase64url(keys.auth).length === 16;
}

function isSubscription(value: unknown): value is PushSubscriptionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.endpoint === 'string' && typeof record.p256dh === 'string' && typeof record.auth === 'string'
    && (record.locale === 'en' || record.locale === 'vi') && typeof record.createdAt === 'string' && typeof record.failures === 'number';
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
