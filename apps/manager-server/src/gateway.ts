import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
/**
 * SillyTavern's own mark, served from the installation rather than kept here.
 *
 * It is their artwork, so the copy that is shown is the copy they shipped -
 * nothing to fall out of date, and nothing of theirs vendored into this
 * repository. The door works without it; the page simply has no picture.
 */
const LOGO_PATH = '/__stm/logo.png';
const LOGO_TTL_MS = 60_000;
const MAX_LOGO_BYTES = 512 * 1024;
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
  readonly lang: 'en' | 'vi';
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
    lang: 'en',
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
    lang: 'vi',
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
  /** Where SillyTavern's own logo is on disk, if there is an installation. */
  readonly brandLogo?: () => Promise<string | null>;
  readonly port?: number;
  readonly targetHost?: string;
  readonly targetPort?: number;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly rateLimiter?: RateLimiter;
  /**
   * Origins allowed to hold this gateway in a frame, beyond its own.
   *
   * The manager's own console goes here and nothing else. SillyTavern sends
   * `X-Frame-Options: SAMEORIGIN`, which is decided on origin rather than
   * site, so the console on port 7860 cannot show a page served on 8001 -
   * the frame comes up blank with nothing in the console to say why. Naming
   * the one origin that may do it is narrower than the header it replaces:
   * `SAMEORIGIN` also permits any other page this gateway itself serves.
   */
  readonly frameAncestors?: readonly string[];
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
  private readonly brandLogo: (() => Promise<string | null>) | null;
  private readonly framePolicy: string;
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
  /**
   * The logo, kept in memory and re-checked on a timer.
   *
   * A timer rather than a subscription because the interesting transition is
   * "nothing installed yet" to "installed", which happens once on a new
   * machine and does not need wiring through three objects to notice.
   */
  private logo: Buffer | null = null;
  private logoCheckedAt = 0;
  private state: Omit<AccessGatewayState, 'sessions'>;

  public constructor(options: AccessGatewayOptions = {}) {
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.port = options.port ?? ACCESS_GATEWAY_PORT;
    this.targetHost = options.targetHost ?? '127.0.0.1';
    this.targetPort = options.targetPort ?? 8000;
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.brandLogo = options.brandLogo ?? null;
    // `'self'` so the sign-in page can still be reached inside whatever frame
    // the console put the gateway in; without it, signing in from the embedded
    // view would blank the frame at the one moment it has something to say.
    const ancestors = (options.frameAncestors ?? []).filter((origin) => origin.length > 0);
    this.framePolicy = ancestors.length > 0 ? `frame-ancestors 'self' ${ancestors.join(' ')}` : "frame-ancestors 'none'";
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
    await this.refreshLogo();
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
    if (pathname === LOGO_PATH) { this.sendLogo(response); return; }
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
      response.writeHead(upstreamResponse.statusCode ?? 502, this.framed(responseHeaders(upstreamResponse)));
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

  /**
   * Who may frame what SillyTavern just answered with.
   *
   * `X-Frame-Options` goes, because it is the header saying no and it cannot
   * express "this one other origin". What replaces it is stricter, not looser.
   * It is added as a second policy rather than merged into any policy
   * SillyTavern sent: two Content-Security-Policy headers are both enforced,
   * so whatever it asked for still holds and this only narrows it further.
   */
  private framed(headers: Record<string, string | string[]>): Record<string, string | string[]> {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'x-frame-options') delete headers[name];
    }
    const existing = headers['content-security-policy'];
    headers['content-security-policy'] = existing === undefined
      ? this.framePolicy
      : [...(Array.isArray(existing) ? existing : [existing]), this.framePolicy];
    return headers;
  }

  /**
   * A session for somebody the manager has already let in.
   *
   * The console's own password is the stronger door: whoever is through it can
   * stop SillyTavern, read its data directory, and change this PIN. Asking
   * them for the PIN as well, to look at the thing they are already
   * administering, guards nothing - so the console mints a session here and
   * the embedded view opens straight into it.
   *
   * It is the same kind of session a correct PIN produces, with the same
   * expiry, and "sign every device out" ends it like any other. That is why
   * this is the only other way one can be created.
   */
  public issueSession(): { token: string; maxAgeSeconds: number } {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, this.now() + this.sessionTtlMs);
    this.logger(logEvent('gateway.consoleSession', '[gateway] opened SillyTavern for the signed-in console', {}));
    return { token, maxAgeSeconds: Math.floor(this.sessionTtlMs / 1000) };
  }

  /** The cookie for a token, so the console can set the one this gateway reads. */
  public sessionCookie(request: IncomingMessage, token: string, maxAgeSeconds: number): string {
    return this.cookie(request, token, maxAgeSeconds);
  }

  private authenticated(request: IncomingMessage): boolean {
    // A valid session is proof on its own. It is only ever handed out by a
    // correct PIN or by the console, so requiring a PIN to exist as well would
    // shut the console out of an installation that has not set one.
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

  /**
   * Reads SillyTavern's logo, or forgets it if there is no installation.
   *
   * Anything unreadable, oversized or simply absent leaves the door with no
   * picture, which is a page that looks plainer and works exactly the same.
   */
  private async refreshLogo(): Promise<void> {
    this.logoCheckedAt = this.now();
    if (!this.brandLogo) return;
    try {
      const path = await this.brandLogo();
      if (!path) { this.logo = null; return; }
      const bytes = await readFile(path);
      this.logo = bytes.byteLength > MAX_LOGO_BYTES ? null : bytes;
    } catch { this.logo = null; }
  }

  private sendLogo(response: ServerResponse): void {
    const bytes = this.logo;
    if (!bytes) { response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return; }
    // An <img> never runs script in an SVG or anything else, and this says so
    // a second time in case something ever links to it directly.
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': bytes.byteLength,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    });
    response.end(bytes);
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
    // Whether there is an installation to take a logo from can change while
    // the manager runs, so the answer is re-checked on a timer rather than
    // decided once at startup. The current answer is used for this page.
    if (this.now() - this.logoCheckedAt > LOGO_TTL_MS) void this.refreshLogo();
    // Appended rather than set, because signing out is already clearing the
    // session cookie on this same response.
    response.appendHeader('Set-Cookie', `${LOGIN_COOKIE_NAME}=${formToken}; Path=${LOGIN_PATH}; HttpOnly; SameSite=Lax; Max-Age=600${secureConnection(request) ? '; Secure' : ''}`);
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; ${this.framePolicy}`,
    });
    response.end(loginPage(text, message, this.passwordHash === null ? text.unconfigured : null, safeNext(next ?? requestPath(request)), formToken, this.passcode, nonce, this.logo !== null));
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

const PAGE_STYLE = `*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-text-size-adjust:100%}:root{color-scheme:dark;--bg:#080b11;--glow:rgba(59,130,246,.16);--panel:#0f1622;--line:#1d2635;--ink:#e9eff7;--muted:#8a9bb0;--brand:#3b82f6;--key:#141d2a;--key-line:#25313f;--key-press:#1d2836;--danger:#fb7185;--shadow:0 1.5rem 3rem -1.75rem rgba(0,0,0,.85)}@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#eef2f9;--glow:rgba(59,130,246,.2);--panel:#fff;--line:#e2e8f2;--ink:#0f172a;--muted:#5a6b82;--key:#f6f8fc;--key-line:#e2e8f2;--key-press:#e6ecf6;--danger:#dc2626;--shadow:0 1.5rem 3rem -1.75rem rgba(15,23,42,.28)}}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:clamp(1rem,5vw,2rem);background:radial-gradient(70rem 36rem at 50% -14%,var(--glow),transparent 72%),var(--bg);color:var(--ink);font:16px/1.55 system-ui,"Segoe UI",Roboto,"Noto Sans",sans-serif;touch-action:manipulation}main{width:min(21.5rem,100%);display:grid;gap:1.25rem}.brand{display:grid;justify-items:center;gap:.375rem;text-align:center}.mark{display:grid;place-items:center;width:5rem;height:5rem;border-radius:1.875rem;background:#242425;border:1px solid rgba(255,255,255,.08);box-shadow:0 1rem 2rem -.75rem rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06)}.mark img{width:3.25rem;height:auto}h1{margin:.5rem 0 0;font-size:1.5rem;font-weight:650;letter-spacing:-.01em}.sub{margin:0;color:var(--muted);font-size:.875rem;text-wrap:balance}form{display:grid;gap:.875rem;padding:1.25rem;border:1px solid var(--line);border-radius:1.125rem;background:var(--panel);box-shadow:var(--shadow)}label{display:block;text-align:center;font-size:.8125rem;color:var(--muted)}input{width:100%;padding:.75rem;border:1px solid var(--key-line);border-radius:.75rem;background:var(--key);color:inherit;font:inherit}input:focus{outline:2px solid var(--brand);outline-offset:1px}button{padding:.75rem;border:0;border-radius:.75rem;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.field{position:relative}.code{text-align:center;letter-spacing:.6em;font-size:1.25rem;padding-left:.6em}.veil{position:absolute;inset:0;z-index:1;width:100%;height:100%;padding:0;border:1px solid transparent;border-radius:.75rem;background:transparent;color:transparent;caret-color:transparent;letter-spacing:normal;cursor:pointer}.veil::selection{background:transparent}.veil:focus{outline:2px solid var(--brand);outline-offset:2px}.dots{display:flex;align-items:center;justify-content:center;gap:.875rem;min-height:3rem;pointer-events:none}.dots i{width:.9rem;height:.9rem;border-radius:50%;border:1.5px solid var(--key-line);transition:background .12s ease,transform .12s ease,border-color .12s ease}.dots i.on{background:var(--brand);border-color:var(--brand);transform:scale(1.15)}.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:.625rem}.pad button{height:3.25rem;padding:0;border:1px solid var(--key-line);border-radius:.875rem;background:var(--key);color:var(--ink);font-size:1.375rem;font-weight:500;transition:background .1s ease,transform .1s ease}.pad button:active{background:var(--key-press);transform:scale(.97)}.pad .wide{background:transparent;border-color:transparent;color:var(--muted);font-size:1.125rem}.note,.muted{margin:0;text-align:center;font-size:.875rem;text-wrap:balance}.note{color:var(--danger)}.muted{color:var(--muted)}.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}@media (max-height:680px){main{gap:1rem}.mark{width:3.75rem;height:3.75rem;border-radius:1.4375rem}.mark img{width:2.5rem}h1{font-size:1.25rem}.pad button{height:2.875rem}form{padding:1rem}}@media (prefers-reduced-motion:reduce){.dots i,.pad button{transition:none}.pad button:active{transform:none}}`;

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
 * has already picked which keyboard they are using. The submit button goes
 * away with the script too - six digits sends the form, the way a lock screen
 * does - and comes back the moment there is no script to send it. Its id is
 * `send` and not `submit` on purpose: a control named `submit` inside a form
 * replaces the form's own `submit()` method with itself, and the script that
 * sends the form then calls a button instead of sending anything.
 *
 * Nothing here zooms. A lock screen is one card that already fits, and a
 * pinch or a double tap on it only ever left the reader looking at a corner
 * of a keypad. The meta tag says so, and because iOS stops reading that tag
 * the moment it decides accessibility is at stake, a handful of lines refuse
 * Safari's own gesture events as well.
 *
 * It is one column at every width, because it is one short thing to do and a
 * second column next to it would only be decoration that has to be designed
 * twice. What changes with the viewport is breathing room, and on a short
 * screen the logo and the keys give some of it back so the keypad still fits
 * above the fold.
 *
 * A door set up before passcodes existed keeps its password field.
 */
function loginPage(text: GatewayText, message: string | null, blocked: string | null, next: string, formToken: string, passcode: boolean, nonce: string, logo: boolean): string {
  const disabled = blocked ? ' disabled' : '';
  const field = passcode
    ? `<label for="password">${escapeHtml(text.passcode)}</label><div class="field"><input id="password" name="password" class="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required${disabled}><div class="dots" id="dots" hidden>${'<i></i>'.repeat(PASSCODE_DIGITS)}</div></div>${keypad(text, blocked !== null)}`
    : `<label for="password">${escapeHtml(text.password)}</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required${disabled}>`;
  /*
   * The mark sits on a dark plate with the corner radius of an app icon.
   *
   * SillyTavern's logo is a dark red outline around white letters, drawn for
   * the dark theme it ships. On a light page the white disappeared into the
   * background and what was left was unreadable. The plate gives it the
   * background it was drawn for, in either theme, and reads as an icon rather
   * than as a picture that happens to be there.
   *
   * `alt` is empty on purpose: the heading under it already says SillyTavern,
   * and a screen reader reading the name twice is worse than not seeing it.
   */
  const mark = logo ? `<span class="mark"><img src="${LOGO_PATH}" alt="" width="96" height="90"></span>` : '';
  return `<!doctype html><html lang="${text.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta name="color-scheme" content="dark light"><meta name="robots" content="noindex,nofollow">${logo ? `<link rel="icon" href="${LOGO_PATH}" type="image/png">` : ''}<title>${escapeHtml(text.signIn)} · SillyTavern</title><style>${PAGE_STYLE}</style></head><body><main><header class="brand">${mark}<h1>SillyTavern</h1><p class="sub">${escapeHtml(text.subtitle)}</p></header><form method="post" action="${LOGIN_PATH}" id="form"><input type="hidden" name="next" value="${escapeHtml(next)}"><input type="hidden" name="token" value="${escapeHtml(formToken)}">${field}<button type="submit" id="send"${disabled}>${escapeHtml(text.submit)}</button></form>${message ? `<p class="${blocked ? 'muted' : 'note'}" role="alert">${escapeHtml(message)}</p>` : ''}</main><script nonce="${escapeHtml(nonce)}">${NO_ZOOM_SCRIPT}${passcode && !blocked ? PASSCODE_SCRIPT : ''}</script></body></html>`;
}

const PASSCODE_DIGITS = 6;

/*
 * Refuse the pinch.
 *
 * `user-scalable=no` is enough for every other browser and is ignored by iOS
 * Safari, which offers these three gesture events instead. Preventing them
 * leaves scrolling, tapping and the browser's own text-size control alone -
 * it only stops the page being scaled by a pinch or a double tap.
 */
const NO_ZOOM_SCRIPT = `for(var z=0,g=['gesturestart','gesturechange','gestureend'];z<3;z++)document.addEventListener(g[z],function(e){e.preventDefault()},{passive:false});`;

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
 * keypad and the dots, lay the field over them, keep them in step, and submit
 * as soon as the sixth digit lands - which is what a phone's lock screen does
 * and what anybody who has used one expects.
 */
const PASSCODE_SCRIPT = `(function(){var i=document.getElementById('password'),p=document.getElementById('pad'),d=document.getElementById('dots'),f=document.getElementById('form'),b=document.getElementById('send');if(!i||!p||!d||!f)return;p.hidden=false;d.hidden=false;if(b)b.hidden=true;i.classList.remove('code');i.classList.add('veil');var s=false;function draw(){var n=i.value.length;var c=d.children;for(var k=0;k<c.length;k++){c[k].className=k<n?'on':''}if(n===6&&!s){s=true;f.submit()}}function set(v){i.value=v.slice(0,6);draw()}i.addEventListener('input',function(){set(i.value.replace(/[^0-9]/g,''))});p.addEventListener('mousedown',function(e){e.preventDefault()});p.addEventListener('click',function(e){var t=e.target.closest('button');if(!t)return;var k=t.getAttribute('data-key');if(k==='clear')set('');else if(k==='back')set(i.value.slice(0,-1));else set(i.value+k)});if(window.matchMedia&&window.matchMedia('(pointer: fine)').matches)i.focus();draw()})();`;

/** The same page with nothing to sign into - SillyTavern is not answering. */
function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>SillyTavern</title><style>${PAGE_STYLE}</style></head><body><main><header class="brand"><h1>SillyTavern</h1><p class="sub">${escapeHtml(message)}</p></header></main></body></html>`;
}
