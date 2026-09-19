import { R2HttpError, type ObjectStore } from './store.js';

/**
 * Which installation is backing up to this bucket.
 *
 * One object, written by whoever is using the bucket and read by everyone
 * before they write to it. It exists because two managers on one account is a
 * shape nothing else in this design notices: they upload under different
 * profile ids, so neither sees the other's recovery points as its own, while
 * the sweep that collects unreferenced chunks is a whole-bucket operation and
 * runs against whatever the other one has uploaded but not yet pointed at.
 *
 * It is a claim, not a lock. A manager that reads it stops on its own; the
 * takeover also takes the other machine's key off the Worker, which is what
 * stops one that is not reading it. The claim survives the machine that made
 * it - that is the point of keeping it in the bucket rather than on a disk -
 * so a machine whose disk was emptied comes back as a stranger and has to say
 * out loud that it is taking over, unless the claim has been left to go stale.
 */
export interface BucketClaim {
  readonly schemaVersion: 1;
  /** The installation, named as the Worker names its key. */
  readonly keyId: string;
  /** Something a reader can recognise a machine by, usually its hostname. */
  readonly label: string;
  readonly claimedAt: string;
  readonly lastSeenAt: string;
}

export const CLAIM_OBJECT = 'owner.json';

/**
 * How long a claim outlives the manager that stopped refreshing it.
 *
 * Long enough that a machine which is merely off for the weekend still owns
 * its bucket when it comes back, short enough that a machine that is never
 * coming back stops being a thing anybody has to press a button about. In
 * between, the panel offers the takeover.
 */
export const CLAIM_STALE_MS = 3 * 24 * 60 * 60 * 1000;

/** How often the holder writes its claim again while it is running. */
export const CLAIM_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Read the claim, or null when nothing has claimed the bucket yet. */
export async function readClaim(store: ObjectStore, key: string): Promise<BucketClaim | null> {
  let body: Buffer;
  try {
    body = await store.getObject(key);
  } catch (error: unknown) {
    if (error instanceof R2HttpError && error.status === 404) return null;
    throw error;
  }
  try {
    return parseClaim(JSON.parse(body.toString('utf8')));
  } catch {
    // A claim nobody can read protects nobody. Treated as absent, which lets
    // the next manager write one that can be read.
    return null;
  }
}

export async function writeClaim(store: ObjectStore, key: string, claim: BucketClaim): Promise<void> {
  await store.putObject(key, Buffer.from(JSON.stringify(claim), 'utf8'), 'application/json');
}

export function parseClaim(value: unknown): BucketClaim | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.keyId !== 'string' || !record.keyId) return null;
  const lastSeenAt = typeof record.lastSeenAt === 'string' ? record.lastSeenAt : null;
  if (lastSeenAt === null || Number.isNaN(Date.parse(lastSeenAt))) return null;
  return {
    schemaVersion: 1,
    keyId: record.keyId,
    label: typeof record.label === 'string' && record.label ? record.label.slice(0, 120) : record.keyId,
    claimedAt: typeof record.claimedAt === 'string' ? record.claimedAt : lastSeenAt,
    lastSeenAt,
  };
}

/** Whether a claim has been left long enough that anybody may take the bucket. */
export function claimIsStale(claim: BucketClaim, now: number): boolean {
  return now - Date.parse(claim.lastSeenAt) > CLAIM_STALE_MS;
}
