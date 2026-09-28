import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { encryptPayload, validSubscription, WebPush } from '../src/web-push.js';

const b64 = (value: string): Buffer => Buffer.from(value, 'base64url');

test('a message is encrypted exactly as RFC 8291 works its own example', () => {
  // Appendix A of RFC 8291, every value as the RFC prints it.
  const body = encryptPayload(
    Buffer.from('When I grow up, I want to be a watermelon', 'utf8'),
    b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    b64('BTBZMqHH6r4Tts7J_aSIgg'),
    { privateKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), publicKey: b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8') },
    b64('DGv6ra1nlYgDCS1FRnbzlw'),
  );
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

/** A browser, as far as a push service is concerned: a key pair and an auth secret. */
function browser(): { publicKey: Buffer; auth: Buffer; decrypt: (body: Buffer) => string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, 9);
  return {
    publicKey: ecdh.getPublicKey(),
    auth,
    decrypt(body) {
      // The receiving half of RFC 8291, written separately from the sender.
      const salt = body.subarray(0, 16);
      const keyLength = body.readUInt8(20);
      const serverPublic = body.subarray(21, 21 + keyLength);
      const shared = ecdh.computeSecret(serverPublic);
      const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
      const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverPublic, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const key = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const sealed = body.subarray(21 + keyLength);
      const decipher = createDecipheriv('aes-128-gcm', key, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
      assert.equal(plain.at(-1), 2, 'one record, ended with the last-record delimiter');
      return plain.subarray(0, -1).toString('utf8');
    },
  };
}

test('a push reaches the push service signed and encrypted, in the subscriber’s language', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-push-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const phone = browser();
  const sent: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  let status = 201;
  const push = new WebPush({
    paths,
    now: () => new Date('2026-09-28T10:00:00.000Z'),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status });
    }) as unknown as typeof globalThis.fetch,
  });
  const publicKey = await push.publicKey();
  assert.equal(b64(publicKey).length, 65);
  await push.subscribe({ endpoint: 'https://push.example/send/abc', p256dh: phone.publicKey.toString('base64url'), auth: phone.auth.toString('base64url'), locale: 'vi' });

  await push.deliver({ id: 'n1', kind: 'sillytavernCrashed', level: 'error', createdAt: '2026-09-28T10:00:00.000Z', readAt: null, params: { detail: 'code 1' } });
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request!.headers['content-encoding'], 'aes128gcm');
  assert.equal(request!.headers.urgency, 'high');
  const message = JSON.parse(phone.decrypt(request!.body)) as { title: string; tag: string };
  assert.equal(message.title, 'SillyTavern dừng bất ngờ');
  assert.equal(message.tag, 'sillytavernCrashed');

  // VAPID: a JWT for this push service's origin, signed by the key the browser was given.
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(request!.headers.authorization ?? '');
  assert.ok(match);
  assert.equal(match[4], publicKey);
  const claims = JSON.parse(b64(match[2]!).toString('utf8')) as { aud: string; exp: number };
  assert.equal(claims.aud, 'https://push.example');
  const raw = b64(publicKey);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b64(match[3]!)));

  // A browser that unsubscribed is forgotten at the first 410.
  status = 410;
  await push.deliver({ id: 'n2', kind: 'installFinished', level: 'success', createdAt: '2026-09-28T10:00:00.000Z', readAt: null, params: { ref: '1.19.0' } });
  assert.equal(await push.has('https://push.example/send/abc'), false);
  // And the key survives a restart, or every browser would have to subscribe again.
  assert.equal(await new WebPush({ paths }).publicKey(), publicKey);
});

test('only a subscription that looks like one is taken', () => {
  const phone = browser();
  const good = { endpoint: 'https://push.example/x', keys: { p256dh: phone.publicKey.toString('base64url'), auth: phone.auth.toString('base64url') } };
  assert.equal(validSubscription(good), true);
  assert.equal(validSubscription({ ...good, endpoint: 'http://push.example/x' }), false);
  assert.equal(validSubscription({ ...good, keys: { ...good.keys, auth: 'short' } }), false);
  assert.equal(validSubscription(null), false);
});
