import type { BackupManifest, Installation, MetricsBucket, R2SnapshotSummary } from './index.js';

/**
 * What each list can be searched and sorted by.
 *
 * Both ends import these. The panel names its columns from the same constants
 * it sends as `sort=`, and the server reads that name through the same
 * function, so a column that sorts one way in a short list cannot sort another
 * way once the list is long enough for the server to take over.
 *
 * A name that is not listed sorts by nothing rather than throwing: an older
 * panel asking for a column a newer server has dropped should get the list in
 * its natural order, not an error page.
 */

export const BACKUP_SORT_FIELDS = ['name', 'createdAt', 'sizeBytes', 'fileCount', 'source'] as const;
export const SNAPSHOT_SORT_FIELDS = ['createdAt', 'indexBytes'] as const;
export const INSTALLATION_SORT_FIELDS = ['resolvedRef', 'channel', 'status', 'createdAt', 'activatedAt'] as const;
export const METRICS_SORT_FIELDS = ['key', 'requests', 'totalTokens', 'inputTokens', 'outputTokens', 'averageLatencyMs'] as const;

export type BackupSortField = typeof BACKUP_SORT_FIELDS[number];
export type SnapshotSortField = typeof SNAPSHOT_SORT_FIELDS[number];
export type InstallationSortField = typeof INSTALLATION_SORT_FIELDS[number];
export type MetricsSortField = typeof METRICS_SORT_FIELDS[number];

type SortValue = string | number | boolean | null | undefined;

/**
 * The text a search box matches against.
 *
 * Only what is on screen. Searching an archive by its checksum finds nothing a
 * reader was looking for, and searching by profile id makes every row match
 * whenever the id happens to share a few characters with what was typed.
 */
export function backupSearchText(backup: BackupManifest): string {
  return `${backup.name} ${backup.profileName}`;
}

export function backupSortValue(backup: BackupManifest, column: string): SortValue {
  switch (column) {
    case 'name': return backup.name;
    case 'createdAt': return backup.createdAt;
    case 'sizeBytes': return backup.sizeBytes;
    case 'fileCount': return backup.fileCount;
    case 'source': return backup.source;
    default: return undefined;
  }
}

export function snapshotSearchText(snapshot: R2SnapshotSummary): string {
  return snapshot.id;
}

export function snapshotSortValue(snapshot: R2SnapshotSummary, column: string): SortValue {
  switch (column) {
    case 'createdAt': return snapshot.createdAt;
    case 'indexBytes': return snapshot.indexBytes;
    default: return undefined;
  }
}

export function installationSearchText(installation: Installation): string {
  return `${installation.resolvedRef} ${installation.selector} ${installation.channel}`;
}

export function installationSortValue(installation: Installation, column: string): SortValue {
  switch (column) {
    case 'resolvedRef': return installation.resolvedRef;
    case 'channel': return installation.channel;
    case 'status': return installation.status;
    case 'createdAt': return installation.createdAt;
    // Never activated sorts last in both directions, which `applyQuery`
    // arranges for anything missing.
    case 'activatedAt': return installation.activatedAt;
    default: return undefined;
  }
}

/**
 * A provider or model row.
 *
 * The name is the only text worth searching: the numbers beside it are counts,
 * and matching "3" against every total finds most of the table.
 */
export function metricsSearchText(bucket: MetricsBucket): string {
  return `${bucket.key} ${bucket.completionSource ?? ''}`;
}

export function metricsSortValue(bucket: MetricsBucket, column: string): SortValue {
  switch (column) {
    case 'key': return bucket.key;
    case 'requests': return bucket.requests;
    case 'totalTokens': return bucket.totalTokens;
    case 'inputTokens': return bucket.inputTokens;
    case 'outputTokens': return bucket.outputTokens;
    case 'averageLatencyMs': return bucket.averageLatencyMs;
    default: return undefined;
  }
}
