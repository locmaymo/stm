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
