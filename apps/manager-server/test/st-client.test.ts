import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProcessStatus } from '../../../packages/contracts/src/index.js';
import { SillyTavernClient, SillyTavernError } from '../src/st-client.js';

/**
 * A SillyTavern that does what 1.19.0 does with a session: a cookie and a
 * token from `/csrf-token`, the token checked on everything that is not GET,
 * and a 403 from `/api/users/me` when accounts are on.
 */
interface FakeOptions {
  accounts?: boolean;
  /** No `/api/users/me` at all, like a version before 1.12. */
  old?: boolean;
  /** Refuse every POST whatever it carries. */
  refuseAll?: boolean;
}

interface Fake {
  readonly server: Server;
  readonly port: number;
  /** Every request, as `METHOD path`. */
  readonly seen: string[];
  tokensIssued: number;
  /** Forget every token handed out, as a restart with a new secret would. */
  rotate(): void;
  close(): Promise<void>;
}

async function fakeSillyTavern(options: FakeOptions = {}): Promise<Fake> {
  const valid = new Map<string, string>();
  let counter = 0;
  const fake: Partial<Fake> & { seen: string[]; tokensIssued: number } = { seen: [], tokensIssued: 0 };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    fake.seen.push(`${request.method} ${path}`);
    const session = /(?:^|;\s*)session-test=([^;]+)/u.exec(request.headers.cookie ?? '')?.[1];
    if (path === '/csrf-token' && request.method === 'GET') {
      counter += 1;
      fake.tokensIssued = counter;
      const id = `s${counter}`;
      const token = `t${counter}`;
      valid.set(id, token);
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`session-test=${id}; path=/; httponly`, `session-test.sig=sig${counter}; path=/; httponly`] });
      response.end(JSON.stringify({ token }));
      return;
    }
    if (path === '/api/users/me' && request.method === 'GET') {
      if (options.old) { response.writeHead(404); response.end('Not found'); return; }
      if (options.accounts) { response.writeHead(403); response.end('Forbidden'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ handle: 'default-user', name: 'User' }));
      return;
    }
    if (request.method !== 'GET') {
      const token = request.headers['x-csrf-token'];
      if (options.refuseAll || !session || valid.get(session) !== token) {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('Invalid CSRF token. Please refresh the page and try again.');
        return;
      }
    }
    if (path === '/api/ping' && request.method === 'POST') { response.writeHead(204); response.end(); return; }
    if (path === '/version' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ pkgVersion: '1.19.0', gitRevision: 'abc1234', gitBranch: 'release', agent: 'SillyTavern:1.19.0:test' }));
      return;
    }
    if (path === '/api/echo' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `session-test=${session ?? ''}; path=/` });
        response.end(JSON.stringify({ type: request.headers['content-type'], body: JSON.parse(body) as unknown }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.rotate = () => valid.clear();
  fake.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return Object.assign(fake, { server, port: (server.address() as AddressInfo).port }) as Fake;
}

function client(port: () => number, status: () => ProcessStatus = () => 'running', readyTimeoutMs = 1_000): SillyTavernClient {
  return new SillyTavernClient({ port, status, readyTimeoutMs, pollMs: 10, requestTimeoutMs: 2_000 });
}

async function refusal(promise: Promise<unknown>): Promise<SillyTavernError> {
  try { await promise; } catch (error: unknown) {
    assert.ok(error instanceof SillyTavernError, `expected a SillyTavernError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to be refused');
}

test('a session is opened once, and its cookie and token go with every request', async (t) => {
  const fake = await fakeSillyTavern();
  t.after(() => fake.close());
  const st = client(() => fake.port);
  await st.ping();
  await st.ping();
  assert.deepEqual(await st.version(), { pkgVersion: '1.19.0', gitRevision: 'abc1234', gitBranch: 'release' });
  assert.equal(fake.tokensIssued, 1);
  assert.deepEqual(fake.seen, ['GET /csrf-token', 'GET /api/users/me', 'POST /api/ping', 'POST /api/ping', 'GET /version']);
});

test('a JSON body is sent as JSON, and a cookie the answer sets is kept', async (t) => {
  const fake = await fakeSillyTavern();
  t.after(() => fake.close());
  const st = client(() => fake.port);
  const response = await st.request('POST', '/api/echo', { body: { name: 'Seraphina' } });
  assert.deepEqual(await response.json(), { type: 'application/json', body: { name: 'Seraphina' } });
  await st.ping();
  assert.equal(fake.tokensIssued, 1);
});

test('a stale token is fetched again once, and the request repeated', async (t) => {
  const fake = await fakeSillyTavern();
  t.after(() => fake.close());
  const st = client(() => fake.port);
  await st.ping();
  fake.rotate();
  await st.ping();
  assert.equal(fake.tokensIssued, 2);
  assert.deepEqual(fake.seen.slice(3), ['POST /api/ping', 'GET /csrf-token', 'GET /api/users/me', 'POST /api/ping']);
});

test('a second refusal is a refusal, with its status, after exactly one retry', async (t) => {
  const fake = await fakeSillyTavern({ refuseAll: true });
  t.after(() => fake.close());
  const error = await refusal(client(() => fake.port).ping());
  assert.equal(error.code, 'st_refused');
  assert.equal(error.status, 403);
  assert.equal(fake.seen.filter((line) => line === 'POST /api/ping').length, 2);
  assert.doesNotMatch(error.message, /CSRF token/u, 'the body of the answer is not repeated');
});

test('user accounts on: refused before anything is asked of SillyTavern', async (t) => {
  const fake = await fakeSillyTavern({ accounts: true });
  t.after(() => fake.close());
  const error = await refusal(client(() => fake.port).ping());
  assert.equal(error.code, 'st_accounts_enabled');
  assert.ok(!fake.seen.includes('POST /api/ping'));
});

test('a version without accounts at all is the default user', async (t) => {
  const fake = await fakeSillyTavern({ old: true });
  t.after(() => fake.close());
  await client(() => fake.port).ping();
  assert.ok(fake.seen.includes('POST /api/ping'));
});

test('stopped is said at once, without a request', async (t) => {
  const fake = await fakeSillyTavern();
  t.after(() => fake.close());
  for (const status of ['stopped', 'stopping', 'error'] as const) {
    const error = await refusal(client(() => fake.port, () => status).ping());
    assert.equal(error.code, 'st_not_running', status);
  }
  assert.deepEqual(fake.seen, []);
});

test('a SillyTavern that is starting is waited for, up to the timeout', async (t) => {
  const fake = await fakeSillyTavern();
  t.after(() => fake.close());
  let status: ProcessStatus = 'starting';
  setTimeout(() => { status = 'running'; }, 50);
  await client(() => fake.port, () => status).ping();
  const error = await refusal(client(() => fake.port, () => 'starting', 60).ping());
  assert.equal(error.code, 'st_not_running');
});

test('nothing on the port is unreachable', async () => {
  const fake = await fakeSillyTavern();
  const port = fake.port;
  await fake.close();
  const error = await refusal(client(() => port).ping());
  assert.equal(error.code, 'st_unreachable');
  assert.equal(error.status, null);
});

test('a SillyTavern moved to another port gets a session of its own there', async (t) => {
  const first = await fakeSillyTavern();
  const second = await fakeSillyTavern();
  t.after(() => Promise.all([first.close(), second.close()]));
  let port = first.port;
  const st = client(() => port);
  await st.ping();
  port = second.port;
  await st.ping();
  assert.equal(first.tokensIssued, 1);
  assert.equal(second.tokensIssued, 1);
  assert.deepEqual(second.seen, ['GET /csrf-token', 'GET /api/users/me', 'POST /api/ping']);
});

test('calls made at the same moment share one session', async (t) => {
  const fake = await fakeSillyTavern();
  t.after(() => fake.close());
  const st = client(() => fake.port);
  await Promise.all([st.ping(), st.ping(), st.version()]);
  assert.equal(fake.tokensIssued, 1);
});
