import { CloudflareApi, segment } from './api.js';

/**
 * What Cloudflare gives away each month, from https://developers.cloudflare.com/r2/pricing/.
 *
 * Per account, not per bucket, and for Standard storage only. Storage is billed
 * as GB-months - the average of each day's peak - so a bucket's size right now
 * is an approximation of that figure, not the figure itself.
 */
export const R2_FREE_TIER = { storageBytes: 10_000_000_000, classA: 1_000_000, classB: 10_000_000 } as const;

/** The operations Cloudflare's pricing page lists as Class A. */
const CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
  'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
/** The operations Cloudflare's pricing page lists as Class B. */
const CLASS_B = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration',
]);
const FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

/** How far back storage is looked for. Measured live: a sample every ten to thirty minutes. */
const STORAGE_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

export type OperationClass = 'A' | 'B' | 'free' | 'unclassified';

export interface OperationCounts {
  readonly classA: number;
  readonly classB: number;
  readonly free: number;
  /** Action types not on the pricing page. Shown, never guessed into a class. */
  readonly unclassified: number;
}

export interface StorageTotals {
  /** Object data plus metadata, in bytes, at the latest sample; null when there was none. */
  readonly storageBytes: number | null;
  readonly objectCount: number | null;
  readonly measuredAt: string | null;
}

export interface R2UsageReport {
  /** The start of the calendar month the operations were counted from, UTC. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bucket: StorageTotals & { readonly name: string; readonly operations: OperationCounts };
  readonly account: StorageTotals & { readonly operations: OperationCounts };
}

export function operationClass(actionType: string): OperationClass {
  if (CLASS_A.has(actionType)) return 'A';
  if (CLASS_B.has(actionType)) return 'B';
  if (FREE.has(actionType)) return 'free';
  return 'unclassified';
}

interface OperationGroup {
  readonly sum?: { readonly requests?: number };
  readonly dimensions?: { readonly actionType?: string; readonly bucketName?: string; readonly responseStatusCode?: number };
}

interface StorageGroup {
  readonly max?: { readonly objectCount?: number; readonly payloadSize?: number; readonly metadataSize?: number };
  readonly dimensions?: { readonly datetime?: string; readonly bucketName?: string };
}

const USAGE_QUERY = `query R2Usage($account: string!, $monthStart: Time!, $storageSince: Time!, $now: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      operations: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $now }) {
        sum { requests }
        dimensions { actionType bucketName responseStatusCode }
      }
      storage: r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $storageSince, datetime_leq: $now }, orderBy: [datetime_DESC]) {
        max { objectCount payloadSize metadataSize }
        dimensions { datetime bucketName }
      }
    }
  }
}`;

/**
 * Month-to-date usage of the backup bucket and of the whole account, from R2's
 * GraphQL analytics.
 *
 * These are usage figures, not billing: Cloudflare offers no API for what has
 * been billed or how much of the free tier is left, a billing period need not
 * start on the first of the month, and analytics lag by some minutes.
 */
export async function readR2Usage(api: CloudflareApi, accountId: string, bucket: string, now: Date = new Date()): Promise<R2UsageReport> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const data = await api.graphql(USAGE_QUERY, {
    account: segment(accountId),
    monthStart: monthStart.toISOString(),
    storageSince: new Date(now.getTime() - STORAGE_LOOKBACK_MS).toISOString(),
    now: now.toISOString(),
  });
  const account = isRecord(data) && isRecord(data.viewer) && Array.isArray(data.viewer.accounts) && isRecord(data.viewer.accounts[0]) ? data.viewer.accounts[0] : {};
  const operations = Array.isArray(account.operations) ? account.operations as OperationGroup[] : [];
  const storage = Array.isArray(account.storage) ? account.storage as StorageGroup[] : [];

  const bucketOperations = countOperations(operations.filter((group) => group.dimensions?.bucketName === bucket));
  const accountOperations = countOperations(operations);
  const latest = latestPerBucket(storage);
  const bucketStorage = latest.get(bucket) ?? { storageBytes: null, objectCount: null, measuredAt: null };
  const samples = [...latest.values()];
  const accountStorage: StorageTotals = samples.length === 0
    ? { storageBytes: null, objectCount: null, measuredAt: null }
    : {
      storageBytes: samples.reduce((sum, sample) => sum + (sample.storageBytes ?? 0), 0),
      objectCount: samples.reduce((sum, sample) => sum + (sample.objectCount ?? 0), 0),
      measuredAt: samples.map((sample) => sample.measuredAt ?? '').sort().at(-1) || null,
    };
  return {
    periodStart: monthStart.toISOString(),
    periodEnd: now.toISOString(),
    bucket: { name: bucket, ...bucketStorage, operations: bucketOperations },
    account: { ...accountStorage, operations: accountOperations },
  };
}

/**
 * What Cloudflare gives away each day on the Workers free plan, from
 * https://developers.cloudflare.com/workers/platform/limits/.
 *
 * Per account and per day, not per script - which is the whole reason this is
 * worth reading. A manager with a Cloudflare account has three Workers on it:
 * the two that put a fixed address in front of the tunnels, and the one that
 * carries backup data to the bucket. They spend one allowance between them,
 * and the first to run out takes the other two down with it.
 *
 * The day ends at midnight UTC, wherever the machine thinks it is.
 */
export const WORKERS_FREE_TIER = { requestsPerDay: 100_000 } as const;

export interface WorkerScriptUsage {
  readonly scriptName: string;
  readonly requests: number;
  readonly errors: number;
}

export interface WorkersUsageReport {
  /** The start of the UTC day counted from, which is when the allowance reset. */
  readonly dayStart: string;
  readonly measuredAt: string;
  /** Every Worker on the account together, which is what the allowance is against. */
  readonly requests: number;
  readonly errors: number;
  /** Broken down per script, so it is possible to see which one is spending it. */
  readonly scripts: readonly WorkerScriptUsage[];
  readonly freeTier: typeof WORKERS_FREE_TIER;
}

interface InvocationGroup {
  readonly sum?: { readonly requests?: number; readonly errors?: number };
  readonly dimensions?: { readonly scriptName?: string };
}

const WORKERS_QUERY = `query WorkersUsage($account: string!, $dayStart: Time!, $now: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      invocations: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $now }) {
        sum { requests errors }
        dimensions { scriptName }
      }
    }
  }
}`;

/**
 * How much of today's Worker allowance the account has spent, per script.
 *
 * Today means the UTC day, because that is the day Cloudflare resets on - in
 * Vietnam that boundary falls at seven in the morning, and counting from local
 * midnight would report a figure against the wrong allowance for seven hours
 * of every day.
 *
 * These are usage figures, not billing: the analytics lag by some minutes and
 * are adaptively sampled, so the number is a close estimate rather than the
 * counter Cloudflare enforces against. Anything deciding whether to back off
 * should leave room for that rather than aiming at the limit.
 */
export async function readWorkersUsage(api: CloudflareApi, accountId: string, now: Date = new Date()): Promise<WorkersUsageReport> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const data = await api.graphql(WORKERS_QUERY, {
    account: segment(accountId),
    dayStart: dayStart.toISOString(),
    now: now.toISOString(),
  });
  const account = isRecord(data) && isRecord(data.viewer) && Array.isArray(data.viewer.accounts) && isRecord(data.viewer.accounts[0]) ? data.viewer.accounts[0] : {};
  const groups = Array.isArray(account.invocations) ? account.invocations as InvocationGroup[] : [];

  // One row per script, because a script can appear more than once: the
  // dimensions Cloudflare groups by are not only the one asked for here.
  const perScript = new Map<string, { requests: number; errors: number }>();
  let requests = 0;
  let errors = 0;
  for (const group of groups) {
    const groupRequests = Math.max(0, Number(group.sum?.requests ?? 0));
    const groupErrors = Math.max(0, Number(group.sum?.errors ?? 0));
    if (!Number.isFinite(groupRequests)) continue;
    requests += groupRequests;
    errors += Number.isFinite(groupErrors) ? groupErrors : 0;
    const name = group.dimensions?.scriptName;
    if (!name) continue;
    const current = perScript.get(name) ?? { requests: 0, errors: 0 };
    perScript.set(name, { requests: current.requests + groupRequests, errors: current.errors + (Number.isFinite(groupErrors) ? groupErrors : 0) });
  }

  return {
    dayStart: dayStart.toISOString(),
    measuredAt: now.toISOString(),
    requests,
    errors,
    scripts: [...perScript.entries()]
      .map(([scriptName, counts]) => ({ scriptName, ...counts }))
      .sort((left, right) => right.requests - left.requests),
    freeTier: { ...WORKERS_FREE_TIER },
  };
}

function countOperations(groups: readonly OperationGroup[]): OperationCounts {
  const counts = { classA: 0, classB: 0, free: 0, unclassified: 0 };
  for (const group of groups) {
    const requests = group.sum?.requests ?? 0;
    // A request refused for lack of permission is not charged.
    const status = group.dimensions?.responseStatusCode;
    if (!Number.isFinite(requests) || requests <= 0 || status === 401 || status === 403) continue;
    const kind = operationClass(group.dimensions?.actionType ?? '');
    if (kind === 'A') counts.classA += requests;
    else if (kind === 'B') counts.classB += requests;
    else if (kind === 'free') counts.free += requests;
    else counts.unclassified += requests;
  }
  return counts;
}

/**
 * Each bucket's most recent storage sample.
 *
 * Summing these for the account matched `GET /r2/metrics` exactly when this was
 * checked, so the GraphQL figure is used for both and they cannot disagree.
 */
function latestPerBucket(groups: readonly StorageGroup[]): Map<string, StorageTotals> {
  const latest = new Map<string, StorageTotals>();
  for (const group of groups) {
    const name = group.dimensions?.bucketName;
    const at = group.dimensions?.datetime ?? '';
    if (!name) continue;
    const current = latest.get(name);
    if (current && (current.measuredAt ?? '') >= at) continue;
    latest.set(name, {
      storageBytes: (group.max?.payloadSize ?? 0) + (group.max?.metadataSize ?? 0),
      objectCount: group.max?.objectCount ?? 0,
      measuredAt: at || null,
    });
  }
  return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
