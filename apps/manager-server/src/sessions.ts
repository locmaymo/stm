import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AdminSession } from '../../../packages/contracts/src/index.js';

/**
 * How long a console session lasts without being used.
 *
 * It used to be twelve hours from sign-in, held only in this process's memory:
 * every restart of the manager - reopening the phone app, a host restarting the
 * container, an update - signed everybody out, and a console left open over a
 * day asked for the password again regardless. Now a session lasts until it has
 * gone unused for this long, and survives restarts. Signing out, changing the
 * password and erasing the manager still end it at once.
 */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often a session in use has its life extended, and written down. */
const RENEW_EVERY_MS = 60 * 60 * 1000;
/**
 * What the cookie itself is told. Browsers cap a cookie at 400 days; the
 * manager decides when a session ends, so the cookie only needs to outlast it.
 */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

interface SessionRecord extends AdminSession {
  readonly id: string;
  lastUsedAt: number;
}

interface StoredSession {
  readonly hash: string;
  readonly id: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly lastUsedAt: number;
}

export interface SessionStoreOptions {
  readonly now?: () => number;
  /** How long an unused session lasts. */
  readonly ttlMs?: number;
  /**
   * Where sessions are kept between runs. Without it they live in memory only,
   * which is what tests want.
   */
  readonly file?: string;
}

/**
 * The console's sessions, by a digest of their token.
 *
 * Only SHA-256 digests of the tokens are held, in memory and on disk, so the
 * sessions file is not a list of cookies: reading it does not let anybody sign
 * in. The CSRF token beside each is useless without the session it belongs to.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly file: string | null;

  public constructor(options: SessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SESSION_IDLE_MS;
    this.file = options.file ?? null;
    this.load();
  }

  public create(): { token: string; session: AdminSession } {
    /*
     * The one place this map grows, and so the place to drop what has expired.
     *
     * An expired session was only ever removed when somebody presented that
     * exact token again - which is the one thing the holder of an expired
     * session does not do, because their browser has been sent back to the
     * sign-in screen. So every sign-in left a record behind for the life of
     * the process: a console signed in from three devices twice a day kept
     * them all, and a manager left running for months kept every one.
     *
     * Here rather than on a timer, because the cost is proportional to the
     * growth: nothing accumulates without this running first.
     */
    this.prune();
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const record: SessionRecord = {
      id: randomUUID(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      csrfToken: randomBytes(32).toString('base64url'),
      lastUsedAt: now,
    };
    this.sessions.set(digest(token), record);
    this.save();
    return { token, session: this.publicSession(record) };
  }

  public get(token: string | undefined): SessionRecord | null {
    if (!token) {
      return null;
    }
    const key = digest(token);
    const record = this.sessions.get(key);
    if (!record) {
      return null;
    }
    const now = this.now();
    if (Date.parse(record.expiresAt) <= now) {
      this.sessions.delete(key);
      this.save();
      return null;
    }
    // In use, so its life starts again - written down at most once an hour,
    // since every request of an open console passes through here.
    if (now - record.lastUsedAt >= RENEW_EVERY_MS) {
      record.lastUsedAt = now;
      const renewed: SessionRecord = { ...record, expiresAt: new Date(now + this.ttlMs).toISOString() };
      this.sessions.set(key, renewed);
      this.save();
      return renewed;
    }
    return record;
  }

  public revoke(token: string | undefined): void {
    if (token && this.sessions.delete(digest(token))) {
      this.save();
    }
  }

  /**
   * End every session except the one asking.
   *
   * A changed password is somebody taking the console back, or closing a
   * door they think was left open; a session opened with the old password
   * should not outlive it, and one that lasts a month would.
   */
  public revokeOthers(token: string | undefined): number {
    const keep = token ? digest(token) : null;
    let count = 0;
    for (const key of [...this.sessions.keys()]) {
      if (key !== keep) { this.sessions.delete(key); count += 1; }
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * End every console session, this one included.
   *
   * A reset takes away the password these were opened with, so leaving them
   * open would leave whoever holds one signed in to a manager that no longer
   * knows who they are.
   */
  public revokeAll(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    this.save();
    return count;
  }

  public size(): number {
    this.prune();
    return this.sessions.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.sessions) {
      if (Date.parse(record.expiresAt) <= now) {
        this.sessions.delete(key);
      }
    }
  }

  /** Sessions from the last run that have not expired. A file that cannot be read is no sessions. */
  private load(): void {
    if (!this.file) return;
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    const list = typeof stored === 'object' && stored !== null && Array.isArray((stored as { sessions?: unknown }).sessions)
      ? (stored as { sessions: unknown[] }).sessions
      : [];
    const now = this.now();
    for (const item of list) {
      if (!isStoredSession(item) || Date.parse(item.expiresAt) <= now) continue;
      this.sessions.set(item.hash, { id: item.id, csrfToken: item.csrfToken, expiresAt: item.expiresAt, lastUsedAt: item.lastUsedAt });
    }
  }

  /**
   * Write the sessions down, readable by this user only, replacing the file
   * whole so a crash mid-write leaves the previous one. A failure to write
   * costs nothing but the sessions surviving the next restart.
   */
  private save(): void {
    if (!this.file) return;
    this.prune();
    const sessions: StoredSession[] = [...this.sessions].map(([hash, record]) => ({
      hash, id: record.id, csrfToken: record.csrfToken, expiresAt: record.expiresAt, lastUsedAt: record.lastUsedAt,
    }));
    const temporary = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, sessions })}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      // Still held in memory for as long as this process runs.
    }
  }

  private publicSession(record: SessionRecord): AdminSession {
    return {
      expiresAt: record.expiresAt,
      csrfToken: record.csrfToken,
    };
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.hash === 'string' && typeof item.id === 'string' && typeof item.csrfToken === 'string'
    && typeof item.expiresAt === 'string' && typeof item.lastUsedAt === 'number';
}

export function parseSessionCookie(cookieHeader: string | undefined, cookieName = 'stm_session'): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === cookieName) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * The part of the session cookie that decides where a browser will send it.
 *
 * On a machine somebody is sitting at, the console is its own tab on
 * `http://127.0.0.1`, and `SameSite=Lax` is right: the cookie goes nowhere it
 * was not asked from.
 *
 * Read through a platform's own preview frame, the console is a document on one
 * site inside a page on another, which is exactly what `Lax` withholds the
 * cookie from. Signing in then appears to do nothing - the password is
 * accepted, the cookie is set, and the very next request arrives without it.
 * `SameSite=None` is what a cookie in a frame needs, and browsers only accept
 * it together with `Secure`, so the two travel together here.
 *
 * `Partitioned` goes with them. Third-party cookies without it are being
 * withdrawn browser by browser, and a cookie the browser will not store is the
 * same broken sign-in again; with it, the console gets a cookie jar of its own
 * per embedding site, which is what it wants anyway - a console framed by one
 * site and a console open in its own tab are not the same session, and should
 * not share one. It also means the cookie cannot follow the reader from site
 * to site, which is the thing the withdrawal is for.
 *
 * What `Lax` was guarding against is guarded twice over regardless: every
 * request that changes anything carries a CSRF token no other site can read,
 * and its Origin has to match the console's own.
 *
 * None of this is relied on. A browser that stores no third-party cookie at
 * all still signs in, because the panel sends the session token as a bearer
 * header as well; see `parseSessionToken` in the server.
 */
function cookieAttributes(secure: boolean): string {
  return secure ? '; SameSite=None; Secure; Partitioned' : '; SameSite=Lax';
}

export function sessionCookie(token: string, secure: boolean): string {
  return `stm_session=${token}; Path=/; HttpOnly; Max-Age=${COOKIE_MAX_AGE_SECONDS}${cookieAttributes(secure)}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `stm_session=; Path=/; HttpOnly; Max-Age=0${cookieAttributes(secure)}`;
}
