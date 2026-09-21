import type { ManagerSettingsOffer } from '../../../packages/contracts/src/index.js';

/** Where the dismissal is remembered, per browser. */
const SEEN_KEY = 'stm-settings-offer-seen';

type OfferStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether to put the settings another machine left in front of the reader.
 *
 * Three things have to be true, and the third is the one that was missing. The
 * bucket has to hold a record; it must not be this installation's own, which
 * the server decides; and the reader must not have already waved this one away.
 *
 * Waving it away is remembered against when the record was written, not
 * against the fact of there being one. Somebody who has decided they do not
 * want the old machine's settings has decided it about those settings - and a
 * machine that later writes new ones has something new to say, so it says it
 * again. There was no way to dismiss this at all before, so a console that was
 * offered settings it did not want carried the offer for good.
 */
export function shouldOfferSettings(offer: ManagerSettingsOffer | null, dismissed: string | null): boolean {
  if (!offer?.available || offer.mine) return false;
  return offer.writtenAt !== dismissed;
}

export function readDismissedSettings(storage?: OfferStorage): string | null {
  try {
    return storage?.getItem(SEEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveDismissedSettings(writtenAt: string, storage?: OfferStorage): void {
  try {
    storage?.setItem(SEEN_KEY, writtenAt);
  } catch {
    // Without storage the offer comes back next time, which is the safe way
    // round: an offer nobody wanted beats settings nobody knew were there.
  }
}

/** Where the recovery notice's dismissal is remembered, per browser. */
const RECOVERY_KEY = 'stm-recovery-notice-seen';

/**
 * Whether to say that this machine's data was fetched back before it started.
 *
 * Worth saying once: a machine that put itself back together looks exactly
 * like one that never lost anything, and the difference is the reader's to
 * know. Worth saying once only - it is news about something that has already
 * finished, and without a way to put it down it sat on the Data page for the
 * life of the installation.
 *
 * Remembered against when the recovery point was taken, so the notice comes
 * back if this ever happens again with a different one.
 */
export function shouldShowRecovery(createdAt: string | null, dismissed: string | null): boolean {
  return createdAt !== null && createdAt !== dismissed;
}

export function readDismissedRecovery(storage?: OfferStorage): string | null {
  try {
    return storage?.getItem(RECOVERY_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveDismissedRecovery(createdAt: string, storage?: OfferStorage): void {
  try {
    storage?.setItem(RECOVERY_KEY, createdAt);
  } catch {
    // Without storage the notice comes back next time, which is one line on a
    // page rather than a reader who never learns their data was restored.
  }
}
