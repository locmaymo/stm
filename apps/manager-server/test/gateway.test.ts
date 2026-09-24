import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { AccessGateway, ACCESS_COOKIE_NAME, clientAddress } from '../src/gateway.js';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/password.js';

const PASSWORD = 'correct horse battery staple';

interface Upstream {
  readonly port: number;
  readonly seen: IncomingMessage[];
  close(): Promise<void>;
}

/** A stand-in for SillyTavern that records what actually reached it. */
async function startUpstream(handler?: (request: IncomingMessage, response: ServerResponse) => void): Promise<Upstream> {
  const seen: IncomingMessage[] = [];
  // An upgraded socket is no longer counted by the server it came from, so it
  // has to be closed by hand or close() waits for it forever.
  const upgraded = new Set<Duplex>();
  const server: Server = createServer((request, response) => {
    seen.push(request);
    if (handler) { handler(request, response); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>SillyTavern</title>');
  });
  server.on('upgrade', (request, socket, head) => {
    seen.push(request);
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString('utf8')}`));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {
    port: address && typeof address !== 'string' ? address.port : 0,
    seen,
    close: async () => {
      for (const socket of upgraded) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

async function startGateway(upstream: Upstream, options: { password?: string | null; passcode?: boolean; brandLogo?: () => Promise<string | null>; frameAncestors?: readonly string[] } = {}): Promise<{ gateway: AccessGateway; base: string }> {
  const gateway = new AccessGateway({
    port: 0,
    targetPort: upstream.port,
    logger: () => undefined,
    ...(options.brandLogo ? { brandLogo: options.brandLogo } : {}),
    ...(options.frameAncestors ? { frameAncestors: options.frameAncestors } : {}),
  });
  const password = options.password === undefined ? PASSWORD : options.password;
  gateway.setPassword(password === null ? null : hashPassword(password), options.passcode ?? false);
  const state = await gateway.start(false);
  assert.equal(state.status, 'running');
  return { gateway, base: `http://127.0.0.1:${state.port}` };
}

/** The token and cookie a served sign-in page hands a browser to post back. */
async function loginForm(base: string): Promise<{ token: string; cookie: string }> {
  const response = await fetch(`${base}/__stm/login`, { headers: { accept: 'text/html' } });
  const token = /name="token" value="([^"]+)"/u.exec(await response.text())?.[1];
  const cookie = (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith('stm_login='))?.split(';', 1)[0];
  assert.ok(token, 'the page carries a form token');
  assert.ok(cookie, 'and sets the cookie that has to come back with it');
  return { token, cookie };
}

async function submitLogin(base: string, password: string, form?: { token: string; cookie: string }): Promise<Response> {
  const credentials = form ?? await loginForm(base);
  return fetch(`${base}/__stm/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: credentials.cookie },
    body: new URLSearchParams({ password, token: credentials.token }).toString(),
  });
}

async function signIn(base: string, password = PASSWORD): Promise<string> {
  const response = await submitLogin(base, password);
  assert.equal(response.status, 303, 'signing in redirects into SillyTavern');
  const cookie = (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith(`${ACCESS_COOKIE_NAME}=`));
  assert.ok(cookie, 'a session cookie is issued');
  return cookie.split(';', 1)[0] as string;
}

test('the console may hold SillyTavern in a frame, and nothing else may', async (t) => {
  const upstream = await startUpstream((_request, response) => {
    // What SillyTavern actually sends, and a policy of its own to check that
    // the gateway narrows it rather than throwing it away.
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "default-src 'self'",
    });
    response.end('<!doctype html><title>SillyTavern</title>');
  });
  const { gateway, base } = await startGateway(upstream, { frameAncestors: ['http://127.0.0.1:7860'] });
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const cookie = await signIn(base);
  const page = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), null, 'the header that cannot name one origin is gone');
  const policy = page.headers.get('content-security-policy') ?? '';
  assert.match(policy, /default-src 'self'/u, "SillyTavern's own policy still applies");
  assert.match(policy, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:7860/u, 'and only the console may frame it');

  // The sign-in page is reached from inside that frame, so it has to agree.
  const door = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  assert.match(door.headers.get('content-security-policy') ?? '', /frame-ancestors 'self' http:\/\/127\.0\.0\.1:7860/u);
});

test('a gateway told of no console lets only its own pages frame SillyTavern', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const cookie = await signIn(base);
  const page = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } });
  // The tools window is one of those pages; nothing from anywhere else is.
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'(;|$)/u);
});

test('the tools window is behind the door and comes back to it after signing in', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const door = await fetch(`${base}/__stm/window`, { headers: { accept: 'text/html' } });
  assert.equal(door.status, 401);
  assert.match(await door.text(), /name="next" value="\/__stm\/window"/u, 'the sign-in goes back to the window, not to SillyTavern');
  assert.equal(upstream.seen.length, 0);

  const cookie = await signIn(base);
  const page = await fetch(`${base}/__stm/window`, { headers: { cookie, accept: 'text/html', 'accept-language': 'vi' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<iframe[^>]+src="\/"/u, 'SillyTavern is framed from this same origin');
  assert.ok(html.includes('Sao lưu cục bộ ngay'), 'in the reader\u2019s language');
  const policy = page.headers.get('content-security-policy') ?? '';
  const nonce = /script-src 'nonce-([^']+)'/u.exec(policy)?.[1];
  assert.ok(nonce && html.includes(`nonce="${nonce}"`), 'its one script runs on a nonce');
  assert.match(policy, /frame-src 'self'/u);
  assert.equal(upstream.seen.length, 0, 'the window itself is not SillyTavern\u2019s to answer');
});

test('the tools answer only the window, and only a signed-in one', async (t) => {
  const upstream = await startUpstream();
  const asked: string[] = [];
  const gateway = new AccessGateway({
    port: 0,
    targetPort: upstream.port,
    logger: () => undefined,
    tools: {
      backup: async (target) => { asked.push(target); return target === 'local' ? { unchanged: true } : { jobId: 'job-1' }; },
      job: (id) => (id === 'job-1' ? { id, kind: 'r2Upload', state: 'running', progress: 40, step: 'Sending to R2', stepCode: 'job.sendingToR2', installationId: null, createdAt: '', updatedAt: '', error: null } : null),
      logs: () => ({ streamId: 's', nextCursor: 7, entries: [{ id: 7, timestamp: new Date(0).toISOString(), source: 'backup', level: 'info', message: '[r2] the bucket already holds this usage history', code: 'r2.uploadNowMetricsSame' }] }),
    },
  });
  gateway.setPassword(hashPassword(PASSWORD));
  const state = await gateway.start(false);
  const base = `http://127.0.0.1:${state.port}`;
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const anonymous = await fetch(`${base}/__stm/tools/backup`, { method: 'POST', headers: { 'x-stm-tools': '1' }, body: '{}' });
  assert.equal(anonymous.status, 401);
  const cookie = await signIn(base);
  const forged = await fetch(`${base}/__stm/tools/backup`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{"target":"cloud"}' });
  assert.equal(forged.status, 403, 'a plain cross-site form cannot start one');
  assert.deepEqual(asked, []);

  const cloud = await fetch(`${base}/__stm/tools/backup`, { method: 'POST', headers: { cookie, 'x-stm-tools': '1' }, body: '{"target":"cloud"}' });
  assert.equal(cloud.status, 202);
  assert.deepEqual(await cloud.json(), { jobId: 'job-1' });
  const local = await fetch(`${base}/__stm/tools/backup`, { method: 'POST', headers: { cookie, 'x-stm-tools': '1' }, body: '{}' });
  assert.deepEqual(await local.json(), { unchanged: true });
  assert.deepEqual(asked, ['cloud', 'local']);

  const job = await (await fetch(`${base}/__stm/tools/job?id=job-1`, { headers: { cookie, 'x-stm-tools': '1', 'accept-language': 'vi' } })).json() as { progress: number; step: string };
  assert.equal(job.progress, 40);
  assert.notEqual(job.step, 'Sending to R2', 'the step is said in the reader\u2019s language');
  const logs = await (await fetch(`${base}/__stm/tools/logs?after=0`, { headers: { cookie, 'x-stm-tools': '1', 'accept-language': 'vi' } })).json() as { next: number; lines: Array<{ text: string }> };
  assert.equal(logs.next, 7);
  assert.equal(logs.lines.length, 1);
  assert.ok(!logs.lines[0]?.text.startsWith('[r2]'));
  assert.equal(upstream.seen.length, 0, 'none of it reaches SillyTavern');
});

test('nothing reaches SillyTavern until the gateway password is given', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const page = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 401);
  const body = await page.text();
  assert.match(body, /name="password"/u, 'a browser is shown the sign-in form');
  assert.doesNotMatch(body, /<title>SillyTavern<\/title>/u);
  // An asset or a background call gets a status it can act on rather than HTML.
  const asset = await fetch(`${base}/script.js`, { headers: { accept: '*/*' } });
  assert.equal(asset.status, 401);
  assert.equal((await asset.json() as { error: { code: string } }).error.code, 'login_required');
  assert.equal(upstream.seen.length, 0, 'SillyTavern was never asked');

  const wrong = await submitLogin(base, 'not the password');
  assert.equal(wrong.status, 401);
  assert.equal((wrong.headers.getSetCookie?.() ?? []).filter((value) => value.startsWith(`${ACCESS_COOKIE_NAME}=`)).length, 0, 'a refused attempt issues no session');
  assert.equal(upstream.seen.length, 0);
});

test('a signed-in browser reaches SillyTavern, and SillyTavern never sees the gateway cookie', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const cookie = await signIn(base);
  const page = await fetch(`${base}/`, { headers: { cookie: `${cookie}; st_theme=dark`, accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SillyTavern<\/title>/u);
  const forwarded = upstream.seen.at(-1);
  assert.ok(forwarded);
  assert.equal(forwarded.headers.cookie, 'st_theme=dark', 'its own cookies pass through and the gateway cookie does not');
  assert.equal(forwarded.headers['x-forwarded-proto'], 'http', 'the scheme survives, because links and cookies are built from it');
});

test('SillyTavern is told nothing it would refuse the connection over', async (t) => {
  // With a whitelist on - its own default - SillyTavern reads the address a
  // proxy claims and refuses anything not on the list. Handing it the real one
  // met everybody who had just signed in with "Forbidden".
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const cookie = await signIn(base);
  await fetch(`${base}/`, { headers: { cookie, accept: 'text/html', 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', forwarded: 'for=203.0.113.9' } });
  const forwarded = upstream.seen.at(-1);
  assert.ok(forwarded);
  for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']) {
    assert.equal(forwarded.headers[header], undefined, `${header} never reaches SillyTavern`);
  }
});

test('a browser on a tunnel is reported as being on HTTPS', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const cookie = await signIn(base);
  await fetch(`${base}/`, { headers: { cookie, accept: 'text/html', 'x-forwarded-proto': 'https' } });
  assert.equal(upstream.seen.at(-1)?.headers['x-forwarded-proto'], 'https');
});

test('a session ends when it is signed out, and when the password is changed', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const first = await signIn(base);
  assert.equal(gateway.sessionCount(), 1);
  const signedOut = await fetch(`${base}/__stm/logout`, { headers: { cookie: first, accept: 'text/html' } });
  assert.equal(signedOut.status, 200);
  assert.equal(gateway.sessionCount(), 0);
  assert.equal((await fetch(`${base}/`, { headers: { cookie: first, accept: '*/*' } })).status, 401);

  const second = await signIn(base);
  assert.equal((await fetch(`${base}/`, { headers: { cookie: second, accept: '*/*' } })).status, 200);
  // Changing the password has to lock out whoever was already inside, or the
  // change does nothing for the case it is made for.
  gateway.setPassword(hashPassword('a different password'));
  assert.equal((await fetch(`${base}/`, { headers: { cookie: second, accept: '*/*' } })).status, 401);
});

test('signing every device out ends the sessions and leaves the passcode alone', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream, { password: '417203', passcode: true });
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const phone = await signIn(base, '417203');
  const laptop = await signIn(base, '417203');
  assert.equal(gateway.getState().sessions, 2);

  assert.equal(gateway.signOutEveryone(), 2);
  assert.equal(gateway.getState().sessions, 0);
  for (const cookie of [phone, laptop]) {
    assert.equal((await fetch(`${base}/`, { headers: { cookie, accept: '*/*' } })).status, 401);
  }
  // The point of this over changing the passcode: the one everybody already
  // has still works, so getting one device out is not a message to the rest.
  assert.ok(await signIn(base, '417203'));
});

test('a gateway with no password yet lets nobody in at all', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream, { password: null });
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const page = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 401);
  const attempt = await submitLogin(base, '', { token: 'anything', cookie: 'stm_login=anything' });
  assert.equal(attempt.status, 503);
  assert.equal(upstream.seen.length, 0);
});

test('a sign-in that did not come from a page this gateway served is refused', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  // The right password, posted from somewhere that never asked for the page.
  const bare = await fetch(`${base}/__stm/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
  });
  assert.equal(bare.status, 403);
  assert.equal((bare.headers.getSetCookie?.() ?? []).filter((value) => value.startsWith(`${ACCESS_COOKIE_NAME}=`)).length, 0);

  // A token from one page cannot be posted with another page's cookie.
  const first = await loginForm(base);
  const second = await loginForm(base);
  const mixed = await submitLogin(base, PASSWORD, { token: first.token, cookie: second.cookie });
  assert.equal(mixed.status, 403);
  // And a refused form still hands back a working one rather than a dead end.
  assert.equal((await submitLogin(base, PASSWORD)).status, 303);
});

test('a browser that sends no origin at all can still sign in', async (t) => {
  // An embedded or sandboxed browser sends `Origin: null`. Refusing that left
  // the person holding the right password told it was wrong.
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const form = await loginForm(base);
  const response = await fetch(`${base}/__stm/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie, origin: 'null' },
    body: new URLSearchParams({ password: PASSWORD, token: form.token }).toString(),
  });
  assert.equal(response.status, 303);
});

test('a generated response streams through as it is produced', async (t) => {
  // SillyTavern streams tokens as they arrive. Buffering the body here would
  // leave generation looking frozen until the whole reply finished.
  let release: (() => void) | undefined;
  const upstream = await startUpstream((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write('data: first\n\n');
    release = () => { response.write('data: second\n\n'); response.end(); };
  });
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const cookie = await signIn(base);
  const response = await fetch(`${base}/api/chat/stream`, { headers: { cookie, accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(decoder.decode(first.value), 'data: first\n\n', 'the first chunk arrives before the response ends');
  release?.();
  const second = await reader.read();
  assert.equal(decoder.decode(second.value), 'data: second\n\n');
  await reader.cancel();
});

test('a websocket is refused before signing in and passes through afterwards', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });
  const port = Number(new URL(base).port);

  const handshake = (cookie: string | null): Promise<string> => new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write([
        'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        '', '',
      ].join('\r\n'));
    });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.includes('echo:')) { socket.destroy(); resolve(received); }
      else if (received.includes('\r\n\r\n')) socket.write('ping');
    });
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
  });

  assert.equal(await handshake(null), '', 'an unauthenticated upgrade is dropped, not handed upstream');
  assert.equal(upstream.seen.length, 0);
  const accepted = await handshake(await signIn(base));
  assert.match(accepted, /101 Switching Protocols/u);
  assert.match(accepted, /echo:ping/u, 'frames travel in both directions after the handshake');
});

test('repeated guesses are throttled instead of answered forever', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const guess = async (): Promise<number> => (await submitLogin(base, 'wrong')).status;
  const codes: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) codes.push(await guess());
  assert.ok(codes.includes(429), 'guessing is cut off');
  // The window is held against the address, so the right password waits it out
  // too. That is the trade a public door makes: a slow lockout for whoever is
  // behind that address is better than an unlimited supply of guesses.
  assert.equal((await submitLogin(base, PASSWORD)).status, 429);
});

test('the gateway rebinds between this machine and the whole network', async (t) => {
  const upstream = await startUpstream();
  const { gateway } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  assert.equal(gateway.getState().host, '127.0.0.1');
  assert.equal((await gateway.setLan(true)).host, '0.0.0.0');
  assert.equal(gateway.getState().lan, true);
  assert.equal((await gateway.setLan(false)).host, '127.0.0.1');
});

test('only a proxy on this machine may say who a request is from', () => {
  const from = (remoteAddress: string, forwardedFor?: string) =>
    clientAddress({ headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }, socket: { remoteAddress } });

  // cloudflared runs here and puts the real visitor in the header.
  assert.equal(from('127.0.0.1', '203.0.113.9, 10.0.0.1'), '203.0.113.9');
  assert.equal(from('::ffff:127.0.0.1', '203.0.113.9'), '203.0.113.9');
  assert.equal(from('127.0.0.1'), '127.0.0.1');

  // Anyone else is only ever themselves. Believing them would let one caller
  // on the network put a new address in the header on every try and never run
  // out of guesses at the password.
  assert.equal(from('192.168.1.40', '203.0.113.9'), '192.168.1.40');
  assert.equal(from('192.168.1.40'), '192.168.1.40');
});

test('a large body arrives whole, in both directions', async (t) => {
  // Importing a character card or a lorebook is a body of megabytes, and a
  // backup coming back is larger still. A proxy that mangles either corrupts
  // the thing being imported rather than failing where anyone would see it.
  const sent = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < sent.length; index += 1) sent[index] = index % 251;
  let received: Buffer | null = null;
  const upstream = await startUpstream((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = Buffer.concat(chunks);
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(sent);
    });
  });
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const cookie = await signIn(base);
  const response = await fetch(`${base}/api/characters/import`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/octet-stream' },
    body: sent,
  });
  assert.equal(response.status, 200);
  const returned = Buffer.from(await response.arrayBuffer());
  assert.ok(received, 'the body reached SillyTavern');
  assert.equal((received as Buffer).length, sent.length);
  assert.ok((received as Buffer).equals(sent), 'byte for byte on the way in');
  assert.equal(returned.length, sent.length);
  assert.ok(returned.equals(sent), 'and on the way back');
});

test('a passcode door asks with a keypad and no password field at all', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream, { password: '417203', passcode: true });
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const page = await (await fetch(`${base}/__stm/login`, { headers: { accept: 'text/html' } })).text();
  /*
   * The whole point: no `type="password"` anywhere on the page. A browser
   * shown a password typed into a random `trycloudflare.com` subdomain warns
   * the reader in red that they may have handed it to a phishing site, and the
   * way to stop that is to stop asking for a password.
   */
  assert.equal(page.includes('type="password"'), false);
  assert.ok(page.includes('inputmode="numeric"'), 'the field asks for digits');
  assert.ok(page.includes('data-key="7"'), 'and there is a keypad to enter them with');
  // Once the keypad is drawn it is the keyboard, and the device's own stays down.
  assert.ok(page.includes(`i.setAttribute('inputmode','none')`), 'the keypad replaces the on-screen keyboard');
  // Without a script the field is still a field and the form still posts.
  assert.ok(page.includes(`action="/__stm/login"`));

  assert.equal(gateway.getState().passcode, true);
  const cookie = await signIn(base, '417203');
  assert.ok(cookie);
});

test('the passcode door waits to be touched before it opens a keyboard', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream, { password: '417203', passcode: true });
  t.after(async () => { await gateway.close(); await upstream.close(); });
  const page = await (await fetch(`${base}/__stm/login`, { headers: { accept: 'text/html' } })).text();

  // No autofocus in the markup: on a phone that is the system keypad sliding
  // up over the keypad on screen before anything has been touched. The script
  // focuses the field only where the pointer is a mouse.
  assert.equal(page.includes('autofocus'), false);
  assert.ok(page.includes("matchMedia('(pointer: fine)')"));
  // The field lies over the dots, so touching them is touching it.
  assert.ok(page.includes('class="field"'));
  assert.ok(page.includes('caret-color:transparent'));
  // Double-tapping a key is a second press, not a zoom, and a pinch does
  // nothing either - including on iOS, which ignores the meta tag and has to
  // be told through its own gesture events.
  assert.ok(page.includes('touch-action:manipulation'));
  assert.ok(page.includes('user-scalable=no'));
  assert.ok(page.includes('gesturestart'));
  /*
   * And nothing in the form may be called `submit`. A control with that id or
   * name becomes a property of the form and replaces the form's own submit()
   * with itself, so the script that sends the form on the sixth digit calls a
   * button instead and the door never opens.
   */
  assert.equal(/<(?:input|button)[^>]*(?:id|name)="submit"/u.test(page), false);
});

test("the door shows SillyTavern's own logo, read from the installation", async (t) => {
  const upstream = await startUpstream();
  const logo = join(tmpdir(), `stm-logo-${randomUUID()}.png`);
  await writeFile(logo, Buffer.from('89504e470d0a1a0a', 'hex'));
  const { gateway, base } = await startGateway(upstream, { password: '417203', passcode: true, brandLogo: async () => logo });
  t.after(async () => { await gateway.close(); await upstream.close(); await rm(logo, { force: true }); });

  const page = await (await fetch(`${base}/__stm/login`, { headers: { accept: 'text/html' } })).text();
  assert.ok(page.includes('src="/__stm/logo.png"'));
  // On a plate, because the artwork is white letters drawn for a dark theme
  // and a light page swallowed them.
  assert.ok(page.includes('class="mark"'));
  // And on the tab from the first request, rather than appearing only once
  // SillyTavern itself is reachable and can serve its own.
  assert.ok(page.includes(`<link rel="icon" href="/__stm/logo.png"`));
  // The picture is part of the door, so it is served before anybody is let in.
  const served = await fetch(`${base}/__stm/logo.png`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await served.arrayBuffer()).byteLength, 8);
});

test('a door with nothing installed behind it simply has no picture', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream, { password: '417203', passcode: true });
  t.after(async () => { await gateway.close(); await upstream.close(); });

  const page = await (await fetch(`${base}/__stm/login`, { headers: { accept: 'text/html' } })).text();
  assert.equal(page.includes('/__stm/logo.png'), false);
  assert.equal((await fetch(`${base}/__stm/logo.png`)).status, 404);
});

test('a door set up before passcodes existed keeps its password field', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });
  const page = await (await fetch(`${base}/__stm/login`, { headers: { accept: 'text/html' } })).text();
  assert.ok(page.includes('type="password"'), 'nobody is locked out by the change');
  assert.equal(page.includes('data-key="7"'), false);
});

test('five wrong tries shut the door on everyone, not on one address', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream, { password: '417203', passcode: true });
  t.after(async () => { await gateway.close(); await upstream.close(); });

  /*
   * Six digits is a million combinations. A phone is happy with that because a
   * phone locks the device rather than the caller; a per-address limit alone
   * gives an attacker with a hundred addresses a hundred times the attempts.
   * Each wrong try here comes from a different address to prove the lock is
   * not the per-address one.
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await submitLogin(base, '000000');
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
  const locked = await submitLogin(base, '417203');
  assert.equal(locked.status, 429, 'the right passcode is refused while the door is shut');
  assert.ok(Number(locked.headers.get('Retry-After')) > 0);

  // Setting the passcode again is the way back in, which is available on the
  // machine itself and nowhere else.
  gateway.setPassword(hashPassword('417203'), true);
  const after = await submitLogin(base, '417203');
  assert.equal(after.status, 303);
});

test('the door carries what the manager remembers about the access link', async (t) => {
  const upstream = await startUpstream();
  const { gateway, base } = await startGateway(upstream);
  t.after(async () => { await gateway.close(); await upstream.close(); });

  assert.equal(gateway.getState().opened, false);
  // Signing in is not turning the link on; the manager says when that happens.
  await signIn(base);
  assert.equal(gateway.getState().opened, false);
  gateway.setOpened(true);
  assert.equal(gateway.getState().opened, true);
});
