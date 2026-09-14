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

export function createSessionWatch(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): SessionWatch {
  const listeners = new Set<SessionListener>();
  let expired = false;

  const notify = () => {
    // Once. Three parallel polls refused at the same instant are one event, and
    // the screen must not be torn down three times.
    if (expired) return;
    expired = true;
    for (const listener of [...listeners]) listener();
  };

  return {
    fetch: async (input, init) => {
      const response = await fetchImpl(input, { credentials: 'same-origin', ...init });
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
