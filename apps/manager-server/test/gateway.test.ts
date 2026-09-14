import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { AccessGateway, ACCESS_COOKIE_NAME, clientAddress } from '../src/gateway.js';
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

async function startGateway(upstream: Upstream, options: { password?: string | null } = {}): Promise<{ gateway: AccessGateway; base: string }> {
  const gateway = new AccessGateway({ port: 0, targetPort: upstream.port, logger: () => undefined });
  const password = options.password === undefined ? PASSWORD : options.password;
  gateway.setPassword(password === null ? null : hashPassword(password));
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
