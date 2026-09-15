import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { logEvent, logLineText, type AccessGatewayState, type LogSink } from '../../../packages/contracts/src/index.js';
import { verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';

export const ACCESS_COOKIE_NAME = 'stm_access';
/** Scoped to the sign-in path, so SillyTavern never receives it either. */
const LOGIN_COOKIE_NAME = 'stm_login';
export const ACCESS_GATEWAY_PORT = 8001 as const;
const LOGIN_PATH = '/__stm/login';
const LOGOUT_PATH = '/__stm/logout';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_BODY_BYTES = 4 * 1024;
/**
 * How long the door stays shut after consecutive failures, whoever they came
 * from. Five wrong tries is a person who has forgotten it; twenty is not.
 */
const LOCKOUT_STEPS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const LOCKOUT_AFTER = 5;
/**
 * Headers that describe one hop and must not be forwarded to the next one.
 *
 * Passing `connection` or `transfer-encoding` through makes Node encode a body
 * twice, and passing `upgrade` through on an ordinary request makes SillyTavern
 * answer a handshake nobody started.
 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

interface GatewayText {
  readonly signIn: string;
  readonly subtitle: string;
  readonly password: string;
  readonly passcode: string;
  readonly digit: string;
  readonly clear: string;
  readonly backspace: string;
  readonly submit: string;
  readonly invalid: string;
  readonly invalidPasscode: string;
  readonly throttled: string;
  readonly unconfigured: string;
  readonly offline: string;
  readonly signedOut: string;
  readonly expired: string;
}

const TEXT: Readonly<Record<'en' | 'vi', GatewayText>> = {
  en: {
    signIn: 'Sign in',
    subtitle: 'This SillyTavern is protected by SillyTavern Manager.',
    password: 'Password',
    passcode: 'Passcode',
    digit: 'Digit {n}',
    clear: 'Clear',
    backspace: 'Delete the last digit',
    submit: 'Sign in',
    invalid: 'That password is not right.',
    invalidPasscode: 'That passcode is not right.',
    throttled: 'Too many attempts. Try again in {seconds} seconds.',
    unconfigured: 'No access password has been set yet. Open SillyTavern Manager on the host machine and set one.',
    offline: 'SillyTavern is not answering yet. It may still be starting.',
    signedOut: 'You are signed out.',
    expired: 'This sign-in page is no longer current. Here is a fresh one - try again.',
  },
  vi: {
    signIn: 'Đăng nhập',
    subtitle: 'SillyTavern này được SillyTavern Manager bảo vệ.',
    password: 'Mật khẩu',
    passcode: 'Mã số',
    digit: 'Số {n}',
    clear: 'Xoá hết',
    backspace: 'Xoá số cuối',
    submit: 'Đăng nhập',
    invalid: 'Mật khẩu không đúng.',
    invalidPasscode: 'Mã không đúng.',
    throttled: 'Thử quá nhiều lần. Hãy thử lại sau {seconds} giây.',
    unconfigured: 'Chưa đặt mật khẩu truy cập. Hãy mở SillyTavern Manager trên máy chủ và đặt một mật khẩu.',
    offline: 'SillyTavern chưa trả lời. Có thể nó vẫn đang khởi động.',
    signedOut: 'Bạn đã đăng xuất.',
    expired: 'Trang đăng nhập này không còn hiệu lực. Đây là trang mới - hãy thử lại.',
  },
};

export interface AccessGatewayOptions {
  readonly logger?: LogSink;
  readonly port?: number;
  readonly targetHost?: string;
  readonly targetPort?: number;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly rateLimiter?: RateLimiter;
}

/**
 * The only door into SillyTavern that is not the loopback address.
 *
 * SillyTavern is kept bound to 127.0.0.1, so a phone on the same network or a
 * Cloudflare tunnel cannot reach it directly at all. They reach this instead: a
 * listener that asks for the manager's SillyTavern password once, keeps a
 * session cookie, and passes everything else straight through.
 *
 * The manager drives this rather than SillyTavern's own protection because the
 * two mechanisms SillyTavern offers are not usable here. Basic Auth is a
 * browser dialog with no sign-out, no session, and nothing the manager can
 * present or reset, and user accounts only exist from 1.12 on, which left every
 * older version with no password at all. One door works on every version.
 */
export class AccessGateway {
  private readonly logger: LogSink;
  private readonly port: number;
  private readonly targetHost: string;
  private readonly targetPort: number;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly attempts: RateLimiter;
  private readonly sessions = new Map<string, number>();
  /**
   * The socket pairs taken over by a protocol upgrade.
   *
   * Once a socket has been upgraded the HTTP server no longer counts it, so
   * closing the server neither closes it nor waits for it. Holding them here is
   * what lets a shutdown actually finish while a page has a socket open.
   */
  private readonly upgraded = new Set<Duplex>();
  /**
   * How many connections to SillyTavern may be open at once.
   *
   * One page load is hundreds of requests, and a browser asks for them all at
   * the same time. Without a limit that many sockets opened at once, and one
   * of them would be refused - which reached the page as a 502 on a random
   * file and left it loading forever.
   *
   * They are not kept alive, because SillyTavern does not keep them alive: it
   * closes an idle connection out from under a proxy that tries to reuse it,
   * and every request that lands on one of those dies with ECONNRESET.
   */
  private readonly upstreamAgent = new Agent({ keepAlive: false, maxSockets: 64 });
  private server: Server | null = null;
  private passwordHash: string | null = null;
  private passcode = false;
  /**
   * Consecutive failures, counted across every source rather than per address.
   *
   * Six digits is a million combinations, which a phone is happy with because
   * a phone locks the whole device rather than one caller. A per-address limit
   * alone does not do that: an attacker with a hundred addresses gets a
   * hundred times the attempts. This is the lock the passcode is worth.
   */
  private failures = 0;
  private lockedUntil = 0;
  private lan = false;
  private state: Omit<AccessGatewayState, 'sessions'>;

  public constructor(options: AccessGatewayOptions = {}) {
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.port = options.port ?? ACCESS_GATEWAY_PORT;
    this.targetHost = options.targetHost ?? '127.0.0.1';
    this.targetPort = options.targetPort ?? 8000;
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    // Ten tries per quarter hour per address. The surface behind this is a
    // public tunnel, so the limit guards a password rather than a form.
    this.attempts = options.rateLimiter ?? new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
    this.state = { status: 'stopped', host: null, port: this.port, lan: false, passwordConfigured: false, passcode: false, error: null };
  }

  public getState(): AccessGatewayState { return { ...this.state, sessions: this.sessionCount() }; }

  /** Adopts a new password, and ends every session opened with the old one. */
  public setPassword(passwordHash: string | null, passcode = false): void {
    this.passwordHash = passwordHash;
    this.passcode = passcode;
    // A credential that has just been changed is a fresh start for whoever is
    // allowed through it.
    this.failures = 0;
    this.lockedUntil = 0;
    this.sessions.clear();
    this.state = { ...this.state, passwordConfigured: passwordHash !== null, passcode };
  }

  public async start(lan = this.lan): Promise<AccessGatewayState> {
    if (this.server) return this.setLan(lan);
    this.lan = lan;
    const host = lan ? '0.0.0.0' : '127.0.0.1';
    const server = createServer((request, response) => { this.handle(request, response); });
    server.on('upgrade', (request, socket, head) => { this.handleUpgrade(request, socket as Duplex, head); });
    // A malformed request line from a scanner on an open port must not be able
    // to end the manager process.
    server.on('clientError', (_error, socket) => { (socket as Duplex).destroy(); });
    server.requestTimeout = 0;
    server.timeout = 0;
    server.headersTimeout = 120_000;
    server.keepAliveTimeout = 120_000;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { server.removeListener('listening', onListening); reject(error); };
        const onListening = (): void => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.port, host);
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'the access gateway could not start';
      this.state = { status: 'error', host: null, port: this.port, lan, passwordConfigured: this.passwordHash !== null, passcode: this.passcode, error: reason };
      this.logger(logEvent('gateway.failed', `[gateway] ${reason}`, { reason }));
      return this.getState();
    }
    this.server = server;
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : this.port;
    this.state = { status: 'running', host, port, lan, passwordConfigured: this.passwordHash !== null, passcode: this.passcode, error: null };
    this.logger(lan
      ? logEvent('gateway.startedLan', `[gateway] SillyTavern access is open to this network on port ${port}`, { port })
      : logEvent('gateway.startedLocal', `[gateway] SillyTavern access is listening on 127.0.0.1:${port}`, { port }));
    return this.getState();
  }

  public async stop(): Promise<AccessGatewayState> {
    const server = this.server;
    this.server = null;
    if (server) {
      for (const socket of this.upgraded) socket.destroy();
      this.upgraded.clear();
      this.upstreamAgent.destroy();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      this.logger(logEvent('gateway.stopped', '[gateway] SillyTavern access is closed'));
    }
    this.state = { ...this.state, status: 'stopped', host: null };
    return this.getState();
  }

  /** Rebinds between this machine only and the whole local network. */
  public async setLan(lan: boolean): Promise<AccessGatewayState> {
    if (this.server && lan === this.lan) return this.getState();
    this.lan = lan;
    if (!this.server) { this.state = { ...this.state, lan }; return this.getState(); }
    await this.stop();
    return this.start(lan);
  }

  public async close(): Promise<void> { await this.stop(); }

  public sessionCount(): number {
    this.pruneSessions();
    return this.sessions.size;
  }

  /**
   * Ends every session at once, without changing the passcode.
   *
   * The passcode is shared with whoever is meant to have it, so changing it to
   * get one forgotten phone out is a message to everybody else too. This is
   * the smaller instrument: every device signs in again, with the passcode
   * they already have.
   */
  public signOutEveryone(): number {
    const count = this.sessionCount();
    this.sessions.clear();
    if (count > 0) this.logger(logEvent('gateway.signedOutAll', `[gateway] signed every device out of SillyTavern (${count})`, { count }));
    return count;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const pathname = requestPath(request);
    const text = TEXT[localeOf(request)];
    if (pathname === LOGOUT_PATH) {
      this.revoke(cookieValue(request.headers.cookie, ACCESS_COOKIE_NAME));
      response.setHeader('Set-Cookie', this.cookie(request, '', 0));
      this.sendLogin(request, response, 200, text, text.signedOut);
      return;
    }
    if (pathname === LOGIN_PATH && (request.method ?? 'GET') === 'POST') { void this.handleLogin(request, response, text); return; }
    if (this.authenticated(request)) {
      if (pathname === LOGIN_PATH) { redirect(response, '/'); return; }
      this.proxy(request, response, text);
      return;
    }
    if (pathname === LOGIN_PATH) { this.sendLogin(request, response, 200, text, null); return; }
    // A browser opening a page gets the door. Anything else - an asset, an API
    // call from a page that was open before the session expired - gets a status
    // it can act on rather than a login page parsed as JSON.
    if (wantsDocument(request)) { this.sendLogin(request, response, 401, text, null, pathname); return; }
    sendJson(response, 401, { error: { code: 'login_required', message: 'Sign in to SillyTavern first' } });
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse, text: GatewayText): Promise<void> {
    if (!this.passwordHash) { this.sendLogin(request, response, 503, text, text.unconfigured); return; }
    let body: string;
    try { body = await readBody(request, MAX_LOGIN_BODY_BYTES); }
    catch { this.sendLogin(request, response, 413, text, this.wrongCredential(text)); return; }
    const form = new URLSearchParams(body);
    // Every sign-in page carries a token that is also set as a cookie, and a
    // submission has to return both. That is what makes this a sign-in from
    // this page rather than from somewhere else, and unlike the Origin header
    // it is not something an embedded or sandboxed browser can strip: one of
    // those sends `Origin: null`, which would leave the person holding the
    // right password told it was wrong, with nothing to do about it.
    if (!matchingToken(form.get('token'), cookieValue(request.headers.cookie, LOGIN_COOKIE_NAME))) {
      this.sendLogin(request, response, 403, text, text.expired, form.get('next') ?? undefined);
      return;
    }
    const locked = this.lockedFor();
    if (locked > 0) {
      response.setHeader('Retry-After', String(locked));
      this.sendLogin(request, response, 429, text, text.throttled.replace('{seconds}', String(locked)), form.get('next') ?? undefined);
      return;
    }
    const limit = this.attempts.check(clientAddress(request));
    if (!limit.allowed) {
      response.setHeader('Retry-After', String(limit.retryAfterSeconds));
      this.sendLogin(request, response, 429, text, text.throttled.replace('{seconds}', String(limit.retryAfterSeconds)));
      return;
    }
    const password = form.get('password') ?? '';
    if (!password || !verifyPassword(password, this.passwordHash)) {
      this.failures += 1;
      const wait = this.lockedFor();
      this.logger(logEvent('gateway.rejected', `[gateway] rejected a sign-in from ${clientAddress(request)}`, { address: clientAddress(request) }));
      this.sendLogin(request, response, 401, text, wait > 0 ? text.throttled.replace('{seconds}', String(wait)) : this.wrongCredential(text), form.get('next') ?? undefined);
      return;
    }
    this.attempts.clear(clientAddress(request));
    this.failures = 0;
    this.lockedUntil = 0;
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, this.now() + this.sessionTtlMs);
    response.setHeader('Set-Cookie', this.cookie(request, token, Math.floor(this.sessionTtlMs / 1000)));
    this.logger(logEvent('gateway.signedIn', `[gateway] signed in from ${clientAddress(request)}`, { address: clientAddress(request) }));
    redirect(response, safeNext(form.get('next')));
  }

  /**
   * Seconds the door is shut for, and zero when it is open.
   *
   * The wait is read off the failure count rather than stored, so it is the
   * same after a restart as before one - a lockout that could be cleared by
   * waiting for a crash is not a lockout.
   */
  /** A passcode is not a password, and being told the wrong one is not is worse. */
  private wrongCredential(text: GatewayText): string {
    return this.passcode ? text.invalidPasscode : text.invalid;
  }

  private lockedFor(): number {
    if (this.failures < LOCKOUT_AFTER) return 0;
    const step = Math.min(this.failures - LOCKOUT_AFTER, LOCKOUT_STEPS_MS.length - 1);
    const wait = LOCKOUT_STEPS_MS[step] ?? 0;
    const until = Math.max(this.lockedUntil, this.now() + wait);
    // Each failure past the threshold pushes the door further out, so a script
    // that keeps trying keeps it shut rather than getting one try per wait.
    this.lockedUntil = until;
    return Math.max(0, Math.ceil((until - this.now()) / 1000));
  }

  private proxy(request: IncomingMessage, response: ServerResponse, text: GatewayText, attempt = 0): void {
    const method = (request.method ?? 'GET').toUpperCase();
    const bodyless = method === 'GET' || method === 'HEAD';
    const upstream = httpRequest({
      host: this.targetHost,
      port: this.targetPort,
      method,
      path: request.url ?? '/',
      headers: forwardedHeaders(request),
      agent: this.upstreamAgent,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse));
      // No compression, no buffering: a token stream has to arrive as it is
      // produced or generation looks frozen until it finishes.
      upstreamResponse.pipe(response);
    });
    upstream.setTimeout(0);
    upstream.on('error', (error: Error) => {
      if (response.headersSent) { response.destroy(); return; }
      // A connection closed before it answered is not an answer. Asking once
      // more costs nothing when the request carried no body, and it is the
      // difference between a page that loads and one that sits on a spinner
      // because a single file of hundreds happened to lose the race.
      if (bodyless && attempt === 0) { this.proxy(request, response, text, 1); return; }
      this.logger(logEvent('gateway.upstreamFailed', `[gateway] ${request.url ?? '/'} did not reach SillyTavern: ${error.message}`, { path: request.url ?? '/', reason: error.message }));
      response.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(errorPage(text.offline));
    });
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    if (bodyless) upstream.end();
    else request.pipe(upstream);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.authenticated(request)) { socket.destroy(); return; }
    // Bytes the client already sent after its request line belong to the
    // conversation, so put them back where the pipe below will find them.
    if (head.length > 0) socket.unshift(head);
    const upstream = httpRequest({
      host: this.targetHost,
      port: this.targetPort,
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: forwardedHeaders(request, true),
      // An upgraded connection belongs to one conversation for its whole life,
      // so it must not come from, or return to, a pool.
      agent: false,
    });
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`];
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        for (const single of Array.isArray(value) ? value : [value]) if (single !== undefined) lines.push(`${name}: ${single}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
      // An upgraded socket is no longer the HTTP server's to close, so one half
      // going away has to take the other with it. Without this a closed tab
      // leaves a pair of sockets held open against SillyTavern for good.
      const tearDown = (): void => {
        this.upgraded.delete(socket);
        this.upgraded.delete(upstreamSocket);
        socket.destroy();
        upstreamSocket.destroy();
      };
      this.upgraded.add(socket);
      this.upgraded.add(upstreamSocket);
      for (const event of ['error', 'close'] as const) {
        socket.on(event, tearDown);
        upstreamSocket.on(event, tearDown);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }

  private authenticated(request: IncomingMessage): boolean {
    if (!this.passwordHash) return false;
    const token = cookieValue(request.headers.cookie, ACCESS_COOKIE_NAME);
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) { this.sessions.delete(token); return false; }
    return true;
  }

  private revoke(token: string | undefined): void { if (token) this.sessions.delete(token); }

  private pruneSessions(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(token);
  }

  private cookie(request: IncomingMessage, token: string, maxAgeSeconds: number): string {
    return `${ACCESS_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureConnection(request) ? '; Secure' : ''}`;
  }

  private sendLogin(request: IncomingMessage, response: ServerResponse, status: number, text: GatewayText, message: string | null, next?: string): void {
    const formToken = randomBytes(18).toString('base64url');
    // The keypad is one inline script, and this page is a public door: it gets
    // a nonce rather than `unsafe-inline`, so the policy still refuses every
    // other script including any that an upstream response could inject.
    const nonce = randomBytes(16).toString('base64');
    // Appended rather than set, because signing out is already clearing the
    // session cookie on this same response.
    response.appendHeader('Set-Cookie', `${LOGIN_COOKIE_NAME}=${formToken}; Path=${LOGIN_PATH}; HttpOnly; SameSite=Lax; Max-Age=600${secureConnection(request) ? '; Secure' : ''}`);
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'`,
    });
    response.end(loginPage(text, message, this.passwordHash === null ? text.unconfigured : null, safeNext(next ?? requestPath(request)), formToken, this.passcode, nonce));
  }
}

function requestPath(request: IncomingMessage): string {
  const url = request.url ?? '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function localeOf(request: IncomingMessage): 'en' | 'vi' {
  return (request.headers['accept-language'] ?? '').toString().toLowerCase().includes('vi') ? 'vi' : 'en';
}

function wantsDocument(request: IncomingMessage): boolean {
  if ((request.headers['sec-fetch-mode'] ?? '') === 'navigate') return true;
  return (request.headers.accept ?? '').toString().includes('text/html');
}

/** Whether this hop arrived over HTTPS, which through a tunnel it does. */
function secureConnection(request: IncomingMessage): boolean {
  return (request.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim() === 'https';
}

function matchingToken(submitted: string | null, expected: string | undefined): boolean {
  if (!submitted || !expected) return false;
  const left = Buffer.from(submitted, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A redirect target that can only be a path on this same gateway. */
function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/__stm')) return '/';
  return value;
}

/**
 * Who this request is from, for the log and for the attempt limit.
 *
 * Only a proxy on this machine may speak for someone else, because the only
 * one there legitimately is cloudflared. Believing the header from anyone
 * would let a caller on the network put a different address in it on every
 * try and have an unlimited number of guesses at the password.
 */
export function clientAddress(request: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string | undefined } }): string {
  const peer = request.socket.remoteAddress ?? 'unknown';
  if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
    const claimed = (request.headers['x-forwarded-for'] ?? '').toString().split(',')[0]?.trim();
    if (claimed) return claimed;
  }
  return peer;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function forwardedHeaders(request: IncomingMessage, keepUpgrade = false): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) && !(keepUpgrade && (name === 'upgrade' || name === 'connection'))) continue;
    headers[name] = value;
  }
  // SillyTavern never sees the gateway's own cookie, so it cannot collide with
  // one of its own and cannot be read by anything it serves.
  const cookie = request.headers.cookie;
  if (cookie) {
    const kept = cookie.split(';').map((part) => part.trim()).filter((part) => !part.startsWith(`${ACCESS_COOKIE_NAME}=`));
    if (kept.length > 0) headers.cookie = kept.join('; ');
    else delete headers.cookie;
  }
  // Tell SillyTavern nothing about who is on the other end of this.
  //
  // It decides whether to answer at all from these: with a whitelist on - its
  // own default - and `enableForwardedWhitelist` on, it reads the address a
  // proxy claims and refuses anything not on the list. Handing it the real
  // address therefore blocked every single person who had just signed in, with
  // "Forbidden" and nothing to do about it. It has no business making that
  // decision any more: it is on the loopback address, the only way to it is
  // this gateway, and the password was already asked for. What it sees now is
  // what is actually true - a local connection from the manager.
  //
  // The address is not lost, it just belongs in the manager's log rather than
  // in a header the upstream might act on.
  for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']) delete headers[name];
  // The scheme does have to survive: through a tunnel the browser is on HTTPS,
  // and SillyTavern builds links and sets cookies from this.
  headers['x-forwarded-proto'] = secureConnection(request) ? 'https' : 'http';
  return headers;
}

function responseHeaders(upstream: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) { request.destroy(); throw new Error('The sign-in form was too large'); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

const PAGE_STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-text-size-adjust:100%}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;font:16px/1.5 system-ui,"Segoe UI",Roboto,"Noto Sans",sans-serif;touch-action:manipulation}main{width:min(22rem,calc(100vw - 2rem));padding:2rem;border:1px solid #1f2833;border-radius:14px;background:#111820}h1{margin:0 0 .25rem;font-size:1.25rem}p{margin:0 0 1.25rem;color:#8b98a5;font-size:.875rem}label{display:block;margin-bottom:.375rem;font-size:.8125rem;color:#8b98a5}input{width:100%;padding:.625rem .75rem;border:1px solid #263241;border-radius:8px;background:#0b0f14;color:inherit;font:inherit}input:focus{outline:2px solid #3b82f6;outline-offset:1px}button{width:100%;margin-top:1rem;padding:.625rem;border:0;border-radius:8px;background:#3b82f6;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}.note{margin:1rem 0 0;color:#f87171}.muted{margin:1rem 0 0;color:#8b98a5}.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-top:1rem}.pad button{margin:0;padding:0;height:3.25rem;border:1px solid #263241;border-radius:10px;background:#0b0f14;color:inherit;font-size:1.25rem;font-weight:500}.pad button:active{background:#18212c}.pad .wide{font-size:.875rem;font-weight:600;color:#8b98a5;background:transparent;border-color:transparent}.field{position:relative}.dots{display:flex;justify-content:center;align-items:center;gap:.75rem;min-height:3rem;margin:.25rem 0 0;pointer-events:none}.dots i{width:.875rem;height:.875rem;border-radius:50%;border:1px solid #37475a;transition:background .12s ease,transform .12s ease}.dots i.on{background:#3b82f6;border-color:#3b82f6;transform:scale(1.1)}.code{text-align:center;letter-spacing:.6em;font-size:1.25rem;padding-left:.6em}.veil{position:absolute;inset:0;z-index:1;width:100%;height:100%;padding:0;border:1px solid transparent;border-radius:10px;background:transparent;color:transparent;caret-color:transparent;letter-spacing:normal;cursor:pointer}.veil::selection{background:transparent}.veil:focus{outline:2px solid #3b82f6;outline-offset:1px}.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}@media (prefers-reduced-motion:reduce){.dots i{transition:none}}`;

/**
 * The door, as a page.
 *
 * A passcode is asked for with a keypad and no password field at all. That is
 * not decoration: this page is reached through a `trycloudflare.com` address,
 * and a browser that sees a password typed into a random subdomain it does not
 * recognise warns the reader, in red, that they may have just handed their
 * password to a phishing site. The warning is reasonable in general and wrong
 * here, and the way to stop it is to stop asking for a password.
 *
 * Without JavaScript the same form is a plain numeric field that submits
 * normally, because a door that needs a working script to open is not a door.
 * The keypad and the dots are added on top of it when there is a script to add
 * them with; the field stays focusable either way, so a physical keyboard and
 * a screen reader both still work.
 *
 * With the script, the field is laid over the dots rather than hidden, with
 * its text and caret made transparent. Touching the dots is then touching the
 * field and brings up the device's keyboard; touching the keypad leaves focus
 * where it is and does not, because somebody pressing the keypad on the screen
 * has already picked which keyboard they are using.
 *
 * A door set up before passcodes existed keeps its password field.
 */
function loginPage(text: GatewayText, message: string | null, blocked: string | null, next: string, formToken: string, passcode: boolean, nonce: string): string {
  const disabled = blocked ? ' disabled' : '';
  const field = passcode
    ? `<label for="password">${escapeHtml(text.passcode)}</label><div class="field"><input id="password" name="password" class="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required${disabled}><div class="dots" id="dots" hidden>${'<i></i>'.repeat(PASSCODE_DIGITS)}</div></div>${keypad(text, blocked !== null)}`
    : `<label for="password">${escapeHtml(text.password)}</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required${disabled}>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(text.signIn)} · SillyTavern</title><style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(text.signIn)}</h1><p>${escapeHtml(text.subtitle)}</p><form method="post" action="${LOGIN_PATH}" id="form"><input type="hidden" name="next" value="${escapeHtml(next)}"><input type="hidden" name="token" value="${escapeHtml(formToken)}">${field}<button type="submit"${disabled}>${escapeHtml(text.submit)}</button></form>${message ? `<p class="${blocked ? 'muted' : 'note'}" role="alert">${escapeHtml(message)}</p>` : ''}</main>${passcode && !blocked ? `<script nonce="${escapeHtml(nonce)}">${PASSCODE_SCRIPT}</script>` : ''}</body></html>`;
}

const PASSCODE_DIGITS = 6;

/** Three rows of digits, then clear, zero and backspace. */
function keypad(text: GatewayText, blocked: boolean): string {
  const key = (label: string, value: string, aria: string, wide = false) =>
    `<button type="button" class="${wide ? 'wide' : ''}" data-key="${escapeHtml(value)}" aria-label="${escapeHtml(aria)}"${blocked ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    .map((digit) => key(digit, digit, text.digit.replace('{n}', digit)))
    .join('');
  return `<div class="pad" id="pad" hidden>${digits}${key('✕', 'clear', text.clear, true)}${key('0', '0', text.digit.replace('{n}', '0'))}${key('⌫', 'back', text.backspace, true)}</div>`;
}

/*
 * Progressive enhancement, in the smallest form that does the job: reveal the
 * keypad and the dots, keep them in step with the field, and submit as soon as
 * the sixth digit lands - which is what a phone's lock screen does and what
 * anybody who has used one expects.
 */
const PASSCODE_SCRIPT = `(function(){var i=document.getElementById('password'),p=document.getElementById('pad'),d=document.getElementById('dots'),f=document.getElementById('form');if(!i||!p||!d||!f)return;p.hidden=false;d.hidden=false;i.classList.remove('code');i.classList.add('veil');var s=false;function draw(){var n=i.value.length;var c=d.children;for(var k=0;k<c.length;k++){c[k].className=k<n?'on':''}if(n===6&&!s){s=true;f.submit()}}function set(v){i.value=v.slice(0,6);draw()}i.addEventListener('input',function(){set(i.value.replace(/[^0-9]/g,''))});p.addEventListener('mousedown',function(e){e.preventDefault()});p.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var k=b.getAttribute('data-key');if(k==='clear')set('');else if(k==='back')set(i.value.slice(0,-1));else set(i.value+k)});if(window.matchMedia&&window.matchMedia('(pointer: fine)').matches)i.focus();draw()})();`;

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SillyTavern</title><style>${PAGE_STYLE}</style></head><body><main><h1>SillyTavern</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
