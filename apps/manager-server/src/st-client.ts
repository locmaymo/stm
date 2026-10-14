import type { ProcessStatus } from '../../../packages/contracts/src/index.js';

/**
 * The manager talking to SillyTavern's own server, the way its page does.
 *
 * Files SillyTavern's server owns - cards, lorebooks, presets, themes, keys -
 * are read from disk on each request, so the safe way to change one while it
 * runs is its own API: that validates what it is given and writes it the way
 * SillyTavern expects. This is the one road to that API.
 *
 * It goes straight to the loopback port, never through the access gateway:
 * whitelist mode admits 127.0.0.1, so no password is involved, and the door's
 * sessions are for people. What it does need is what the page needs - a
 * session cookie and the CSRF token that belongs to it - and both are fetched
 * here, kept, and fetched again once when SillyTavern says no.
 *
 * It never logs a request or a response body: those are keys, cards and
 * prompts. An error says what went wrong and with which status, nothing more.
 *
 * Checked against SillyTavern 1.19.0: `GET /csrf-token` answers
 * `{ token }` and starts a cookie session; every request that is not GET
 * carries `X-CSRF-Token`; `GET /api/users/me` answers 403 when user accounts
 * are on and nobody is signed in, and is absent (404) before 1.12.
 */

export type SillyTavernErrorCode =
  /** It is not running, or did not come up in time; the caller can take the stopped-file road instead. */
  | 'st_not_running'
  /** User accounts are on; the manager only looks after `default-user`. */
  | 'st_accounts_enabled'
  /** Nothing answered on its port. */
  | 'st_unreachable'
  /** It answered, and the answer was a refusal or an error. */
  | 'st_refused';

export class SillyTavernError extends Error {
  public readonly code: SillyTavernErrorCode;
  /** SillyTavern's HTTP status, when it answered at all. */
  public readonly status: number | null;

  public constructor(code: SillyTavernErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'SillyTavernError';
    this.code = code;
    this.status = status;
  }
}

export interface SillyTavernClientOptions {
  /** Which port SillyTavern is on, read at each call: the console can move it. */
  readonly port: () => number;
  /** The supervisor's word on whether it is running. */
  readonly status: () => ProcessStatus;
  readonly host?: string;
  /** How long a call waits for a SillyTavern that is still starting. */
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  /** How long one request may take before it counts as unanswered. */
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export interface SillyTavernRequestOptions {
  /** A JSON body; sent with `content-type: application/json`. */
  readonly body?: unknown;
  /** Overrides how long to wait for a SillyTavern that is starting. */
  readonly readyTimeoutMs?: number;
}

/** What `GET /version` says about the running copy. */
export interface SillyTavernVersion {
  readonly pkgVersion: string;
  readonly gitRevision: string | null;
  readonly gitBranch: string | null;
}

interface Session {
  readonly port: number;
  readonly cookies: Map<string, string>;
  readonly token: string;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class SillyTavernClient {
  private readonly port: () => number;
  private readonly status: () => ProcessStatus;
  private readonly host: string;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private session: Session | null = null;
  /** One session being opened at a time, however many calls asked for it. */
  private opening: Promise<Session> | null = null;

  public constructor(options: SillyTavernClientOptions) {
    this.port = options.port;
    this.status = options.status;
    this.host = options.host ?? '127.0.0.1';
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Which version is running; also the cheapest proof that a session works. */
  public async version(): Promise<SillyTavernVersion> {
    const response = await this.request('GET', '/version');
    const body: unknown = await response.json().catch(() => null);
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    if (typeof record.pkgVersion !== 'string') throw new SillyTavernError('st_refused', 'SillyTavern did not say which version it is', response.status);
    return {
      pkgVersion: record.pkgVersion,
      gitRevision: typeof record.gitRevision === 'string' ? record.gitRevision : null,
      gitBranch: typeof record.gitBranch === 'string' ? record.gitBranch : null,
    };
  }

  /** A request that passes the CSRF check and changes nothing. */
  public async ping(): Promise<void> {
    await this.request('POST', '/api/ping');
  }

  /**
   * One request to SillyTavern, with the session and token it needs.
   *
   * Resolves only for a 2xx answer, which the caller reads. A 403 is taken
   * first as a token that went stale - SillyTavern restarted, or the session
   * cookie changed - so the session is opened again and the request repeated
   * once; a second 403 is a real refusal.
   */
  public async request(method: string, path: string, options: SillyTavernRequestOptions = {}): Promise<Response> {
    await this.ready(options.readyTimeoutMs ?? this.readyTimeoutMs);
    for (let attempt = 0; ; attempt += 1) {
      const session = await this.currentSession();
      const response = await this.send(session, method, path, options.body);
      if (response.ok) return response;
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 403 && attempt === 0) {
        if (this.session === session) this.session = null;
        continue;
      }
      throw new SillyTavernError('st_refused', `SillyTavern answered ${method} ${path} with ${response.status}`, response.status);
    }
  }

  /**
   * Waits for the supervisor to say SillyTavern is running.
   *
   * Starting is worth waiting for; stopped, stopping or failed is not, and
   * says so at once so the caller can choose the stopped-file road instead.
   */
  private async ready(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const status = this.status();
      if (status === 'running') return;
      if (status !== 'starting') throw new SillyTavernError('st_not_running', 'SillyTavern is not running');
      if (Date.now() >= until) throw new SillyTavernError('st_not_running', 'SillyTavern did not finish starting in time');
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async currentSession(): Promise<Session> {
    const port = this.port();
    if (this.session && this.session.port === port) return this.session;
    this.session = null;
    if (!this.opening) {
      this.opening = this.open(port).finally(() => { this.opening = null; });
    }
    const session = await this.opening;
    // A port that moved while the session was being opened gets its own.
    return session.port === this.port() ? session : this.currentSession();
  }

  /** A cookie session with its CSRF token, refused when user accounts are on. */
  private async open(port: number): Promise<Session> {
    const cookies = new Map<string, string>();
    const tokenResponse = await this.raw(port, 'GET', '/csrf-token', cookies);
    keepCookies(tokenResponse, cookies);
    const body: unknown = await tokenResponse.json().catch(() => null);
    const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
    if (!tokenResponse.ok || typeof token !== 'string' || token === '') {
      throw new SillyTavernError('st_refused', `SillyTavern did not hand out a CSRF token (${tokenResponse.status})`, tokenResponse.status);
    }
    // Who the session is. With accounts off this is always `default-user`;
    // with them on, nobody is signed in and SillyTavern says so with a 403. A
    // version too old to have accounts has no such route at all.
    const me = await this.raw(port, 'GET', '/api/users/me', cookies);
    keepCookies(me, cookies);
    await me.body?.cancel().catch(() => undefined);
    if (me.status === 403 || me.status === 401) {
      throw new SillyTavernError('st_accounts_enabled', 'SillyTavern has user accounts turned on; the manager only looks after the default user', me.status);
    }
    const session: Session = { port, cookies, token };
    this.session = session;
    return session;
  }

  private async send(session: Session, method: string, path: string, body: unknown): Promise<Response> {
    const response = await this.raw(session.port, method, path, session.cookies, session.token, body);
    keepCookies(response, session.cookies);
    return response;
  }

  private async raw(port: number, method: string, path: string, cookies: Map<string, string>, token?: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers.cookie = cookie;
    if (token) headers['x-csrf-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.fetchImpl(`http://${this.host}:${port}${path}`, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error: unknown) {
      if (this.session?.port === port) this.session = null;
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'did not answer in time' : 'could not be reached';
      throw new SillyTavernError('st_unreachable', `SillyTavern on port ${port} ${reason}`);
    }
  }
}

/** The cookies a response sets, kept; one it expires, forgotten. */
function keepCookies(response: Response, cookies: Map<string, string>): void {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0] ?? '';
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const expired = value === '' || /;\s*max-age=0\b/iu.test(line) || /;\s*expires=Thu, 01 Jan 1970/iu.test(line);
    if (expired) cookies.delete(name);
    else cookies.set(name, value);
  }
}
