import type { BubbleState } from './app-bridge.js';
import { browserStorage } from './preferences.js';

/**
 * When the console offers something the reader would otherwise have to go
 * looking for: chat bubbles in the Android app, notifications on a phone that
 * opened the console from its Home Screen.
 *
 * A switch nobody opens the bell to find is a switch nobody turns on, so the
 * console asks instead: once, then once more a fortnight after "Not now", and
 * never again after that or once the reader said yes. The answer is kept in
 * this browser's storage, because both are about this one device.
 */

export const BUBBLE_OFFER_KEY = 'stm-bubble-offer';
export const PUSH_OFFER_KEY = 'stm-push-offer';
const ASK_AGAIN_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ASKS = 2;

interface Answered {
  readonly at: number;
  readonly times: number;
}

function parse(raw: string | null): Answered | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Answered>;
    return typeof value.at === 'number' && typeof value.times === 'number' ? { at: value.at, times: value.times } : null;
  } catch {
    return null;
  }
}

/** Whether to ask: never answered, or "Not now" long enough ago and not too often. */
export function offerDue(raw: string | null, now: number): boolean {
  const answered = parse(raw);
  if (!answered) return true;
  return answered.times < MAX_ASKS && now - answered.at >= ASK_AGAIN_MS;
}

/** What is kept after "Not now". */
export function offerSnoozed(raw: string | null, now: number): string {
  return JSON.stringify({ at: now, times: (parse(raw)?.times ?? 0) + 1 });
}

/** What is kept after a yes: turning it off later is an answer too, and not one to argue with. */
export function offerAccepted(now: number): string {
  return JSON.stringify({ at: now, times: MAX_ASKS });
}

/** Whether there is anything to offer: a phone that floats bubbles, and they are not both on already. */
export function bubbleOfferWanted(state: BubbleState | null): boolean {
  return state !== null && state.bubbles && !(state.replies && state.enabled);
}

export function readOffer(key: string): string | null {
  try { return browserStorage()?.getItem(key) ?? null; } catch { return null; }
}

export function writeOffer(key: string, value: string): void {
  try { browserStorage()?.setItem(key, value); } catch { /* a browser that keeps nothing is asked again next time */ }
}
