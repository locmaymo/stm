import { R2HttpError, type ObjectStore } from './store.js';

/**
 * What this bucket has been charged for, kept in the bucket.
 *
 * Cloudflare bills R2 by the operation - writes and listings are Class A,
 * reads are Class B - and gives away a million and ten million of them a
 * month. The manager has always counted its own, but it counted them into a
 * file on the machine, which answers the question only for as long as that
 * machine keeps its disk. Move to a new computer, reinstall, or run on a
 * hosted studio that starts each time from the checkout, and the count goes
 * back to zero on the first of an arbitrary day, in the middle of a month
 * whose real total is unknown.
 *
 * Cloudflare's own analytics answer it properly, but only for somebody signed
 * in with an account that granted analytics - not for the many people who
 * paste in an S3 key, for whom there is no API at all and therefore no way to
 * find out how much of the month they have spent.
 *
 * So the count goes where the data goes. It starts at zero the first time a
 * bucket is used, every machine adds what it has spent since it last wrote,
 * and any machine that connects to the account afterwards reads the month's
 * true total whether or not it was the one that spent it.
 *
 * It is a count of what this manager did, which is not a bill: anything else
 * touching the bucket is invisible to it, and Cloudflare rounds and reports on
 * its own schedule. Where the analytics are available they are still the
 * figure to trust, and this one stands behind them.
 */
export interface BucketUsage {
  readonly schemaVersion: 1;
  /** When a manager first wrote this record, which is the zero it counts from. */
  readonly startedAt: string;
  readonly updatedAt: string;
  /** Charged operations per calendar month in UTC, keyed `YYYY-MM`. */
  readonly months: Readonly<Record<string, MonthlyOperations>>;
}

export interface MonthlyOperations {
  /** Writes and listings. */
  readonly classA: number;
  /** Reads. */
  readonly classB: number;
}

export const USAGE_OBJECT = 'usage.json';

/**
 * How long the record is kept for.
 *
 * Thirteen months, so that a month can always be compared with the same month
 * a year before, and so the object stays a few hundred bytes forever.
 */
export const USAGE_MONTHS_KEPT = 13;

/**
 * How often what has been spent is written to the bucket.
 *
 * The write is itself a charged operation, so writing after every backup would
 * mean counting the counting. Every fifteen minutes is a few hundred writes a
 * month against an allowance of a million, and the most a crash can lose is
 * fifteen minutes of one machine's operations.
 */
export const USAGE_FLUSH_MS = 15 * 60 * 1000;

/** The `YYYY-MM` key a moment falls in, in UTC, which is how Cloudflare bills. */
export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Read the record, or null when no manager has written one for this bucket. */
export async function readUsage(store: ObjectStore, key: string): Promise<BucketUsage | null> {
  let body: Buffer;
  try {
    body = await store.getObject(key);
  } catch (error: unknown) {
    if (error instanceof R2HttpError && error.status === 404) return null;
    throw error;
  }
  try {
    return parseUsage(JSON.parse(body.toString('utf8')));
  } catch {
    // A record nobody can read is worse than none: treated as absent, so the
    // next write replaces it rather than adding to something meaningless.
    return null;
  }
}

export async function writeUsage(store: ObjectStore, key: string, usage: BucketUsage): Promise<void> {
  await store.putObject(key, Buffer.from(JSON.stringify(usage), 'utf8'), 'application/json');
}

export function parseUsage(value: unknown): BucketUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : null;
  if (updatedAt === null || Number.isNaN(Date.parse(updatedAt))) return null;
  const months: Record<string, MonthlyOperations> = {};
  const stored = record.months;
  if (typeof stored === 'object' && stored !== null) {
    for (const [key, entry] of Object.entries(stored as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}$/u.test(key) || typeof entry !== 'object' || entry === null) continue;
      const month = entry as Record<string, unknown>;
      months[key] = { classA: count(month.classA), classB: count(month.classB) };
    }
  }
  const startedAt = typeof record.startedAt === 'string' && !Number.isNaN(Date.parse(record.startedAt)) ? record.startedAt : updatedAt;
  return { schemaVersion: 1, startedAt, updatedAt, months };
}

/**
 * Add one machine's spending to the record, and drop months nobody will ask
 * about again.
 *
 * Addition rather than replacement, because the record belongs to the bucket
 * and the delta belongs to the machine: two managers that used the account in
 * the same month both contributed to the bill, and the one writing now has no
 * way to know what the other spent beyond what is already written here.
 */
export function addOperations(previous: BucketUsage | null, month: string, delta: MonthlyOperations, now: Date): BucketUsage {
  const timestamp = now.toISOString();
  const current = previous?.months[month] ?? { classA: 0, classB: 0 };
  const months: Record<string, MonthlyOperations> = {
    ...previous?.months,
    [month]: { classA: current.classA + Math.max(0, delta.classA), classB: current.classB + Math.max(0, delta.classB) },
  };
  const kept = Object.keys(months).sort().slice(-USAGE_MONTHS_KEPT);
  return {
    schemaVersion: 1,
    startedAt: previous?.startedAt ?? timestamp,
    updatedAt: timestamp,
    months: Object.fromEntries(kept.map((key) => [key, months[key] as MonthlyOperations])),
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
