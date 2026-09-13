import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { logEvent, logLineText, type AccessGatewayState, type LogSink } from '../../../packages/contracts/src/index.js';
import { verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';

export const ACCESS_COOKIE_NAME = 'stm_access';
export const ACCESS_GATEWAY_PORT = 8001 as const;
const LOGIN_PATH = '/__stm/login';
const LOGOUT_PATH = '/__stm/logout';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_BODY_BYTES = 4 * 1024;
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
  readonly submit: string;
  readonly invalid: string;
  readonly throttled: string;
  readonly unconfigured: string;
  readonly offline: string;
  readonly signedOut: string;
}

const TEXT: Readonly<Record<'en' | 'vi', GatewayText>> = {
  en: {
    signIn: 'Sign in',
    subtitle: 'This SillyTavern is protected by SillyTavern Manager.',
    password: 'Password',
    submit: 'Sign in',
    invalid: 'That password is not right.',
    throttled: 'Too many attempts. Try again in {seconds} seconds.',
    unconfigured: 'No access password has been set yet. Open SillyTavern Manager on the host machine and set one.',
    offline: 'SillyTavern is not answering yet. It may still be starting.',
    signedOut: 'You are signed out.',
  },
  vi: {
    signIn: 'Đăng nhập',
    subtitle: 'SillyTavern này được SillyTavern Manager bảo vệ.',
    password: 'Mật khẩu',
    submit: 'Đăng nhập',
    invalid: 'Mật khẩu không đúng.',
    throttled: 'Thử quá nhiều lần. Hãy thử lại sau {seconds} giây.',
    unconfigured: 'Chưa đặt mật khẩu truy cập. Hãy mở SillyTavern Manager trên máy chủ và đặt một mật khẩu.',
    offline: 'SillyTavern chưa trả lời. Có thể nó vẫn đang khởi động.',
    signedOut: 'Bạn đã đăng xuất.',
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
  private server: Server | null = null;
  private passwordHash: string | null = null;
  private lan = false;
  private state: AccessGatewayState;

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
    this.state = { status: 'stopped', host: null, port: this.port, lan: false, passwordConfigured: false, error: null };
  }

  public getState(): AccessGatewayState { return { ...this.state }; }

  /** Adopts a new password, and ends every session opened with the old one. */
  public setPassword(passwordHash: string | null): void {
    this.passwordHash = passwordHash;
    this.sessions.clear();
    this.state = { ...this.state, passwordConfigured: passwordHash !== null };
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
      this.state = { status: 'error', host: null, port: this.port, lan, passwordConfigured: this.passwordHash !== null, error: reason };
      this.logger(logEvent('gateway.failed', `[gateway] ${reason}`, { reason }));
      return this.getState();
    }
    this.server = server;
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : this.port;
    this.state = { status: 'running', host, port, lan, passwordConfigured: this.passwordHash !== null, error: null };
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

  /** The addresses a browser can reach SillyTavern on, for the console to show. */
  public sessionCount(): number {
    this.pruneSessions();
    return this.sessions.size;
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
    // The form is served from this same origin, so a request that claims to
    // come from somewhere else is not one of ours.
    if (!sameOrigin(request)) { this.sendLogin(request, response, 403, text, text.invalid); return; }
    if (!this.passwordHash) { this.sendLogin(request, response, 503, text, text.unconfigured); return; }
    const limit = this.attempts.check(clientAddress(request));
    if (!limit.allowed) {
      response.setHeader('Retry-After', String(limit.retryAfterSeconds));
      this.sendLogin(request, response, 429, text, text.throttled.replace('{seconds}', String(limit.retryAfterSeconds)));
      return;
    }
    let body: string;
    try { body = await readBody(request, MAX_LOGIN_BODY_BYTES); }
    catch { this.sendLogin(request, response, 413, text, text.invalid); return; }
    const form = new URLSearchParams(body);
    const password = form.get('password') ?? '';
    if (!password || !verifyPassword(password, this.passwordHash)) {
      this.logger(logEvent('gateway.rejected', `[gateway] rejected a sign-in from ${clientAddress(request)}`, { address: clientAddress(request) }));
      this.sendLogin(request, response, 401, text, text.invalid, form.get('next') ?? undefined);
      return;
    }
    this.attempts.clear(clientAddress(request));
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, this.now() + this.sessionTtlMs);
    response.setHeader('Set-Cookie', this.cookie(request, token, Math.floor(this.sessionTtlMs / 1000)));
    this.logger(logEvent('gateway.signedIn', `[gateway] signed in from ${clientAddress(request)}`, { address: clientAddress(request) }));
    redirect(response, safeNext(form.get('next')));
  }

  private proxy(request: IncomingMessage, response: ServerResponse, text: GatewayText): void {
    const upstream = httpRequest({
      host: this.targetHost,
      port: this.targetPort,
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: forwardedHeaders(request),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse));
      // No compression, no buffering: a token stream has to arrive as it is
      // produced or generation looks frozen until it finishes.
      upstreamResponse.pipe(response);
    });
    upstream.setTimeout(0);
    upstream.on('error', () => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(errorPage(text.offline));
    });
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
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
    // Through a tunnel the connection is HTTPS and the cookie must say so; on
    // the local network it is plain HTTP, where Secure would discard it.
    const secure = (request.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim() === 'https';
    return `${ACCESS_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  private sendLogin(request: IncomingMessage, response: ServerResponse, status: number, text: GatewayText, message: string | null, next?: string): void {
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    });
    response.end(loginPage(text, message, this.passwordHash === null ? text.unconfigured : null, safeNext(next ?? requestPath(request))));
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

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

/** A redirect target that can only be a path on this same gateway. */
function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/__stm')) return '/';
  return value;
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = (request.headers['x-forwarded-for'] ?? '').toString().split(',')[0]?.trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
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
  headers['x-forwarded-for'] = clientAddress(request);
  headers['x-forwarded-proto'] = (request.headers['x-forwarded-proto'] ?? 'http').toString();
  if (request.headers.host) headers['x-forwarded-host'] = request.headers.host;
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

const PAGE_STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;font:16px/1.5 system-ui,"Segoe UI",Roboto,"Noto Sans",sans-serif}main{width:min(22rem,calc(100vw - 2rem));padding:2rem;border:1px solid #1f2833;border-radius:14px;background:#111820}h1{margin:0 0 .25rem;font-size:1.25rem}p{margin:0 0 1.25rem;color:#8b98a5;font-size:.875rem}label{display:block;margin-bottom:.375rem;font-size:.8125rem;color:#8b98a5}input{width:100%;padding:.625rem .75rem;border:1px solid #263241;border-radius:8px;background:#0b0f14;color:inherit;font:inherit}input:focus{outline:2px solid #3b82f6;outline-offset:1px}button{width:100%;margin-top:1rem;padding:.625rem;border:0;border-radius:8px;background:#3b82f6;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}.note{margin:1rem 0 0;color:#f87171}.muted{margin:1rem 0 0;color:#8b98a5}`;

function loginPage(text: GatewayText, message: string | null, blocked: string | null, next: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(text.signIn)} · SillyTavern</title><style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(text.signIn)}</h1><p>${escapeHtml(text.subtitle)}</p><form method="post" action="${LOGIN_PATH}"><input type="hidden" name="next" value="${escapeHtml(next)}"><label for="password">${escapeHtml(text.password)}</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required${blocked ? ' disabled' : ''}><button type="submit"${blocked ? ' disabled' : ''}>${escapeHtml(text.submit)}</button></form>${message ? `<p class="${blocked ? 'muted' : 'note'}" role="alert">${escapeHtml(message)}</p>` : ''}</main></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SillyTavern</title><style>${PAGE_STYLE}</style></head><body><main><h1>SillyTavern</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
