import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminSession } from '../../../packages/contracts/src/index.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionRecord extends AdminSession {
  readonly id: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  }

  public create(): { token: string; session: AdminSession } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
    const record: SessionRecord = {
      id: randomUUID(),
      expiresAt,
      csrfToken: randomBytes(32).toString('base64url'),
    };
    this.sessions.set(token, record);
    return { token, session: this.publicSession(record) };
  }

  public get(token: string | undefined): SessionRecord | null {
    if (!token) {
      return null;
    }
    const record = this.sessions.get(token);
    if (!record) {
      return null;
    }
    if (Date.parse(record.expiresAt) <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return record;
  }

  public revoke(token: string | undefined): void {
    if (token) {
      this.sessions.delete(token);
    }
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
    return count;
  }

  public size(): number {
    this.prune();
    return this.sessions.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, record] of this.sessions) {
      if (Date.parse(record.expiresAt) <= now) {
        this.sessions.delete(token);
      }
    }
  }

  private publicSession(record: SessionRecord): AdminSession {
    return {
      expiresAt: record.expiresAt,
      csrfToken: record.csrfToken,
    };
  }
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
 * What `Lax` was guarding against is guarded twice over regardless: every
 * request that changes anything carries a CSRF token no other site can read,
 * and its Origin has to match the console's own.
 */
function cookieAttributes(secure: boolean): string {
  return secure ? '; SameSite=None; Secure' : '; SameSite=Lax';
}

export function sessionCookie(token: string, secure: boolean): string {
  return `stm_session=${token}; Path=/; HttpOnly; Max-Age=${SESSION_TTL_MS / 1000}${cookieAttributes(secure)}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `stm_session=; Path=/; HttpOnly; Max-Age=0${cookieAttributes(secure)}`;
}
