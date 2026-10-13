import type { BridgeCommand, BridgeCommandStatus, BridgeResult } from '../../../packages/contracts/src/index.js';
import { readFailure } from './api-error.js';
import { apiFetch } from './session.js';

export interface RunInSillyTavernOptions {
  readonly csrfToken: string;
  readonly onWaiting?: (waiting: boolean) => void;
  readonly signal?: AbortSignal;
  /** Test hook; the panel's own `apiFetch` otherwise. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Test hook: how long to wait after a request that did not get through. */
  readonly retryMs?: number;
}

const COMMANDS = '/api/v1/sillytavern/bridge/commands';
/** How long each status request may be held open by the manager, in seconds. */
const WAIT_SECONDS = 25;
/** Requests in a row that may fail to get through before giving up. */
const MAX_MISSES = 3;

/**
 * Ask the open SillyTavern tab to do something, and wait for its answer.
 *
 * What the tab owns - the connection profile, API, model, key and theme it has
 * in memory - is changed through the tab while one is open; see the server's
 * st-bridge.ts. The command is queued on the manager and goes to the tab that
 * was looked at last. With no tab open it waits there, up to ten minutes, for
 * one to be opened: `onWaiting(true)` is the moment to tell the reader so,
 * and to offer the road that works with SillyTavern stopped where there is
 * one; `onWaiting(false)` is a tab having taken it.
 *
 * Resolves with the tab's answer, or with `{ ok: false, error }` when the
 * manager refused the command or it expired. Rejects only when `signal` is
 * aborted or the manager cannot be reached at all; aborting also withdraws a
 * command no tab has taken yet.
 */
export async function runInSillyTavern(command: BridgeCommand, options: RunInSillyTavernOptions): Promise<BridgeResult> {
  const call = options.fetch ?? apiFetch;
  const sent = await call(COMMANDS, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': options.csrfToken },
    body: JSON.stringify(command),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!sent.ok) return refused(sent);
  let status = await sent.json() as BridgeCommandStatus;
  let waiting = false;
  let misses = 0;
  for (;;) {
    if (status.state === 'done' || status.state === 'expired') {
      if (waiting) options.onWaiting?.(false);
      return status.result ?? { ok: false, error: 'expired' };
    }
    const nobody = status.state === 'waiting' && status.tabs === 0;
    if (nobody !== waiting) { waiting = nobody; options.onWaiting?.(nobody); }
    let next: Response;
    try {
      next = await call(`${COMMANDS}/${encodeURIComponent(status.id)}?wait=${WAIT_SECONDS}`, options.signal ? { signal: options.signal } : {});
    } catch (error: unknown) {
      // Whoever asked stopped waiting: a command no tab has taken yet is
      // withdrawn, so it does not run when a tab opens later.
      if (options.signal?.aborted) {
        void call(`${COMMANDS}/${encodeURIComponent(status.id)}`, { method: 'DELETE', headers: { 'x-csrf-token': options.csrfToken } }).catch(() => undefined);
        throw error;
      }
      // A dropped connection on a ten-minute wait is not the end of it.
      if (++misses >= MAX_MISSES) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 2_000));
      continue;
    }
    misses = 0;
    if (!next.ok) {
      if (waiting) options.onWaiting?.(false);
      return refused(next);
    }
    status = await next.json() as BridgeCommandStatus;
  }
}

async function refused(response: Response): Promise<BridgeResult> {
  const failure = readFailure(await response.json().catch(() => null));
  return { ok: false, error: failure.code ?? `http_${response.status}` };
}
