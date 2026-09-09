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

export function sessionCookie(token: string, secure: boolean): string {
  const securePart = secure ? '; Secure' : '';
  return `stm_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${securePart}`;
}

export function clearSessionCookie(secure: boolean): string {
  const securePart = secure ? '; Secure' : '';
  return `stm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${securePart}`;
}
