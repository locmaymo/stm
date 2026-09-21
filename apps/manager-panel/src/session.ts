/**
 * One place that notices the manager has stopped accepting the session.
 *
 * The console polls the runtime three times every one and a half seconds. When
 * a session expired, every one of those came back 401, nothing read the status,
 * and the panel carried on asking - silently, forever, until the tab had
 * collected a few thousand refusals and stopped responding. The reader was
 * looking at a console showing a machine it could no longer see.
 *
 * Routing the calls through here means the refusal is read once, the panel goes
 * back to the sign-in screen and says why, and the polling stops because the
 * console that owned the timers is no longer mounted.
 */

export type SessionListener = () => void;

export interface SessionWatch {
  /** `fetch`, plus: the first 401 tells the panel the session is gone. */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Returns an unsubscribe, so an unmounted console stops hearing about it. */
  readonly subscribe: (listener: SessionListener) => () => void;
  /** Arms the watch again, after a fresh sign-in. */
  readonly reset: () => void;
  readonly expired: () => boolean;
}

/**
 * A 403 is deliberately not counted. That is the CSRF check, which a live
 * session can still fail - on a stale token, say - and signing the reader out
 * over it would turn a retryable refusal into a lost session.
 */
export function isSessionRefusal(status: number): boolean {
  return status === 401;
}

/**
 * The session token, held here as well as in the cookie.
 *
 * A cookie is enough everywhere the console is a page of its own. Shown inside
 * another site's frame it is not: the cookie is then a third-party cookie, and
 * a browser that declines to store it leaves a console where the password is
 * accepted and the very next call comes back 401. So the token the sign-in
 * handed over is kept here too, and sent as `Authorization: Bearer` on every
 * call - which no browser withholds, and no other site can make this one send.
 *
 * `sessionStorage`, not `localStorage`: this is a credential, and it should
 * last exactly as long as the tab that was signed in. Reading it can throw
 * where storage is walled off inside a frame, which is why it is also held in
 * a variable - a console that cannot store anything still works until reload.
 */
const TOKEN_KEY = 'stm_session';
let held: string | null = null;

export function setSessionToken(token: string | null): void {
  held = token;
  try {
    if (token) globalThis.sessionStorage?.setItem(TOKEN_KEY, token);
    else globalThis.sessionStorage?.removeItem(TOKEN_KEY);
  } catch {
    // Storage walled off; the variable above is the whole store for this page.
  }
}

export function sessionToken(): string | null {
  if (held) return held;
  try {
    held = globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    held = null;
  }
  return held;
}

export function createSessionWatch(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, token: () => string | null = sessionToken): SessionWatch {
  const listeners = new Set<SessionListener>();
  let expired = false;

  const notify = () => {
    // Once. Three parallel polls refused at the same instant are one event, and
    // the screen must not be torn down three times.
    if (expired) return;
    expired = true;
    // Whatever the manager has stopped accepting, sending it again will not
    // help, and a stale one left in storage outlives the tab's next reload.
    setSessionToken(null);
    for (const listener of [...listeners]) listener();
  };

  return {
    fetch: async (input, init) => {
      const bearer = token();
      const headers = new Headers(init?.headers);
      // Not overwritten: a call site that set its own is saying something.
      if (bearer && !headers.has('authorization')) headers.set('authorization', `Bearer ${bearer}`);
      const response = await fetchImpl(input, { credentials: 'same-origin', ...init, headers });
      if (isSessionRefusal(response.status)) notify();
      return response;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => { expired = false; },
    expired: () => expired,
  };
}

const watch = createSessionWatch((input, init) => globalThis.fetch(input, init));

/** Every manager call in the panel goes through this. */
export const apiFetch = watch.fetch;
export const onSessionExpired = watch.subscribe;
export const resetSessionWatch = watch.reset;
