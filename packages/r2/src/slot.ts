import { R2HttpError, type ObjectStore, type SlotResult, type SlotTiming } from './store.js';

/**
 * A slot is a key that the first writer keeps and every later writer loses.
 *
 * Several devices share one set of data, and each change to it takes the next
 * number in a line. Two devices may reach for the same number. Exactly one has
 * to get it, and the other has to find out, without either of them holding a
 * lock: a phone that took a lock and then lost its signal would shut every
 * other device out.
 *
 * What a store can promise differs. An S3 bucket refuses a write to a key that
 * exists. Google Drive refuses nothing and lets one name hold many files, but
 * stamps each with its own clock, so the earliest is the same file to every
 * reader. The others are asked first, written, and asked again after a pause.
 *
 * A writer that believes it won and did not is not a disaster, only a
 * nuisance. Everything it has is in storage before it reaches for the slot, so
 * the worst outcome is a chat that exists twice.
 */

/**
 * Long enough for a small write started at the same moment to have landed.
 *
 * Every send by a device that shares its data waits this long, so it is paid
 * many times an hour; twenty rounds against a real Drive account never showed
 * a write that was not listed at once.
 */
export const SLOT_SETTLE_MS = 1000;
/** A small write that takes this long is not one to trust the order of. */
export const SLOT_STALL_MS = 10_000;

export interface SlotOptions {
  readonly settleMs?: number;
  readonly stallMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Try to take a slot with `body`.
 *
 * `body` has to be this attempt's alone - it carries the device and a random
 * value - because holding the slot is decided by reading it back and finding
 * these bytes there.
 */
export async function claimSlot(store: ObjectStore, key: string, body: Uint8Array, options: SlotOptions = {}): Promise<SlotResult> {
  const timing: SlotTiming = {
    settleMs: options.settleMs ?? SLOT_SETTLE_MS,
    stallMs: options.stallMs ?? SLOT_STALL_MS,
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: options.now ?? Date.now,
  };
  if (store.claimSlot) return await store.claimSlot(key, body, timing);

  const before = await read(store, key);
  if (before) return { won: false, holder: before };
  if (store.putIfAbsent) {
    if (!await store.putIfAbsent(key, body, 'application/json')) return { won: false, holder: await read(store, key) };
  } else {
    await store.putObject(key, body, 'application/json');
  }
  // Another writer that asked before this one wrote may still be writing.
  await timing.sleep(timing.settleMs);
  const after = await read(store, key);
  return { won: after !== null && after.equals(Buffer.from(body)), holder: after };
}

/** What holds a slot, or null when nothing does. */
export async function readSlot(store: ObjectStore, key: string): Promise<Buffer | null> {
  if (store.readSlot) return await store.readSlot(key);
  return await read(store, key);
}

async function read(store: ObjectStore, key: string): Promise<Buffer | null> {
  try {
    return await store.getObject(key);
  } catch (error: unknown) {
    if (error instanceof R2HttpError && error.status === 404) return null;
    throw error;
  }
}
