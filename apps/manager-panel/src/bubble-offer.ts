import type { BubbleState } from './app-bridge.js';

/**
 * When the overview offers chat bubbles in the Android app.
 *
 * The switch has always been there, at the foot of the bell, and a switch
 * nobody opens the bell to find is a switch nobody turns on. So the overview
 * asks: once, then once more a fortnight after "Not now", and never again
 * after that or once bubbles are on. The answer is kept on this phone, in the
 * app's own page storage, because bubbles are this phone's.
 */

export const BUBBLE_OFFER_KEY = 'stm-bubble-offer';
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

/** Whether "Not now" was said recently enough, or often enough, not to ask. */
export function bubbleOfferDue(raw: string | null, now: number): boolean {
  const answered = parse(raw);
  if (!answered) return true;
  return answered.times < MAX_ASKS && now - answered.at >= ASK_AGAIN_MS;
}

/** What is kept after "Not now". */
export function bubbleOfferSnoozed(raw: string | null, now: number): string {
  return JSON.stringify({ at: now, times: (parse(raw)?.times ?? 0) + 1 });
}

/** What is kept after "Turn on": turning them off later in the bell is an answer too, and not one to argue with. */
export function bubbleOfferAccepted(now: number): string {
  return JSON.stringify({ at: now, times: MAX_ASKS });
}

/** Whether there is anything to offer: a phone that floats bubbles, and they are not both on already. */
export function bubbleOfferWanted(state: BubbleState | null): boolean {
  return state !== null && state.bubbles && !(state.replies && state.enabled);
}
