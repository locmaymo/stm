import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyQuery, backupSearchText, backupSortValue, installationSearchText, installationSortValue,
  metricsSearchText, metricsSortValue,
  pageInfo, parseTableQuery, snapshotSortValue, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  METRICS_SORT_FIELDS,
} from '../src/index.js';
import type { BackupManifest, Installation, MetricsBucket, R2SnapshotSummary } from '../src/index.js';

function backup(overrides: Partial<BackupManifest>): BackupManifest {
  return {
    schemaVersion: 1, id: 'b1', name: 'nightly', createdAt: '2026-01-01T00:00:00.000Z',
    profileId: 'p1', profileName: 'Default', layout: 'data', sizeBytes: 1024,
    checksumSha256: 'abc', fileCount: 10, source: 'created', ...overrides,
  };
}

test('a request that asks for no page is given the whole list', () => {
  // Every caller in the panel sends nothing. A list endpoint that started
  // answering those with the first ten rows would hide data silently.
  assert.equal(parseTableQuery(new URLSearchParams('')), null);
  assert.equal(parseTableQuery(new URLSearchParams('source=all&after=0')), null);
});

test('any one paging parameter is enough to ask for a page', () => {
  for (const raw of ['page=2', 'pageSize=5', 'q=nightly', 'sort=name']) {
    assert.notEqual(parseTableQuery(new URLSearchParams(raw)), null, raw);
  }
});

test('the parts left out fall back to the defaults', () => {
  const query = parseTableQuery(new URLSearchParams('q=nightly'));
  assert.deepEqual(query, { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: 'nightly', sort: null, direction: 'asc' });
});

test('a page size is capped, and a page number cannot go below one', () => {
  const huge = parseTableQuery(new URLSearchParams('pageSize=100000&page=-4'));
  assert.equal(huge?.pageSize, MAX_PAGE_SIZE);
  assert.equal(huge?.page, 1);
  assert.equal(parseTableQuery(new URLSearchParams('pageSize=0'))?.pageSize, 1);
});

test('a parameter that is not a number is treated as absent, not as an error', () => {
  const query = parseTableQuery(new URLSearchParams('page=banana&pageSize='));
  assert.equal(query?.page, 1);
  assert.equal(query?.pageSize, DEFAULT_PAGE_SIZE);
});

test('only "desc" reverses the order', () => {
  assert.equal(parseTableQuery(new URLSearchParams('sort=name&direction=desc'))?.direction, 'desc');
  assert.equal(parseTableQuery(new URLSearchParams('sort=name&direction=DESC'))?.direction, 'asc');
  assert.equal(parseTableQuery(new URLSearchParams('sort=name'))?.direction, 'asc');
  // An empty sort is no sort, not a column named "".
  assert.equal(parseTableQuery(new URLSearchParams('sort='))?.sort, null);
});

test('a page beyond the end comes back as the last page', () => {
  const rows = [backup({ id: 'a' }), backup({ id: 'b' }), backup({ id: 'c' })];
  const query = parseTableQuery(new URLSearchParams('page=9&pageSize=2'));
  assert.ok(query);
  const result = applyQuery(rows, query);
  assert.equal(result.page, 2);
  assert.deepEqual(result.rows.map((row) => row.id), ['c']);
  assert.deepEqual(pageInfo(result, query.pageSize), { page: 2, pageSize: 2, total: 3, pageCount: 2 });
});

test('a backup is searched by what is on screen, not by its checksum', () => {
  const row = backup({ name: 'before upgrade', profileName: 'Main', checksumSha256: 'deadbeef' });
  const text = backupSearchText(row).toLocaleLowerCase();
  assert.ok(text.includes('before upgrade'));
  assert.ok(text.includes('main'));
  // Matching a checksum finds a row nobody was looking for.
  assert.equal(text.includes('deadbeef'), false);
});

test('backup columns sort on the value the column shows', () => {
  assert.equal(backupSortValue(backup({ sizeBytes: 900 }), 'sizeBytes'), 900);
  assert.equal(backupSortValue(backup({ name: 'nightly' }), 'name'), 'nightly');
  // A column the server does not know sorts on nothing rather than throwing,
  // so an older panel asking for a dropped column still gets its list.
  assert.equal(backupSortValue(backup({}), 'somethingElse'), undefined);
});

test('sizes sort as numbers and names sort as a reader reads them', () => {
  const rows = [
    backup({ id: 'a', name: 'backup 10', sizeBytes: 90 }),
    backup({ id: 'b', name: 'backup 2', sizeBytes: 1000 }),
  ];
  const byName = applyQuery(rows, { page: 1, pageSize: 10, search: '', sort: 'name', direction: 'asc' }, { sortValue: backupSortValue });
  assert.deepEqual(byName.rows.map((row) => row.id), ['b', 'a'], '"backup 2" comes before "backup 10"');
  const bySize = applyQuery(rows, { page: 1, pageSize: 10, search: '', sort: 'sizeBytes', direction: 'asc' }, { sortValue: backupSortValue });
  assert.deepEqual(bySize.rows.map((row) => row.id), ['a', 'b']);
});

test('an installation that was never activated stays last in both directions', () => {
  const base = {
    selector: 'latest', resolvedRef: '1.18.0', channel: 'release', runtimePath: '/r', markerPath: '/m',
    status: 'ready', progress: 100, step: '', error: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as const;
  const rows: Installation[] = [
    { ...base, id: 'never', activatedAt: null },
    { ...base, id: 'older', activatedAt: '2026-01-02T00:00:00.000Z' },
    { ...base, id: 'newer', activatedAt: '2026-03-02T00:00:00.000Z' },
  ];
  const options = { sortValue: installationSortValue };
  const query = { page: 1, pageSize: 10, search: '', sort: 'activatedAt' } as const;
  assert.deepEqual(applyQuery(rows, { ...query, direction: 'asc' }, options).rows.map((row) => row.id), ['older', 'newer', 'never']);
  assert.deepEqual(applyQuery(rows, { ...query, direction: 'desc' }, options).rows.map((row) => row.id), ['newer', 'older', 'never']);
  assert.ok(installationSearchText(rows[0]!).includes('1.18.0'));
});

test('a recovery point sorts by when it was taken and by what it holds', () => {
  const snapshot: R2SnapshotSummary = { id: 's1', profileId: 'p1', createdAt: '2026-02-02T00:00:00.000Z', indexBytes: 42, fileCount: 3, dataBytes: 9000 };
  assert.equal(snapshotSortValue(snapshot, 'createdAt'), '2026-02-02T00:00:00.000Z');
  assert.equal(snapshotSortValue(snapshot, 'indexBytes'), 42);
  assert.equal(snapshotSortValue(snapshot, 'dataBytes'), 9000);
  assert.equal(snapshotSortValue(snapshot, 'profileId'), undefined);
});

test('a provider row sorts by every number the panel puts in a column', () => {
  const bucket = (values: Partial<MetricsBucket>): MetricsBucket => ({
    key: 'anthropic', requests: 3, inputTokens: 10, outputTokens: 4, totalTokens: 14,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheEligibleInputTokens: 0,
    cacheObservedRequests: 0, cacheHitRate: null, streamRequests: 0, errors: 0, errorRate: 0,
    averageLatencyMs: 120, ...values,
  });
  // Every id the metrics tables name as a column has to be a name this
  // function answers to, or that column sorts by nothing at all.
  for (const column of METRICS_SORT_FIELDS) {
    assert.notEqual(metricsSortValue(bucket({}), column), undefined, column);
  }
  assert.equal(metricsSortValue(bucket({}), 'errorRate'), undefined);

  const rows = [bucket({ key: 'a', requests: 1 }), bucket({ key: 'b', requests: 90 }), bucket({ key: 'c', requests: 9 })];
  const sorted = applyQuery(rows, { page: 1, pageSize: 10, search: '', sort: 'requests', direction: 'desc' }, { sortValue: metricsSortValue });
  assert.deepEqual(sorted.rows.map((row) => row.key), ['b', 'c', 'a']);

  // The counts are not searchable: typing "9" to find a model would otherwise
  // match every row whose totals happen to contain a nine.
  assert.equal(metricsSearchText(bucket({ key: 'claude', completionSource: 'chat' })), 'claude chat');
  assert.equal(metricsSearchText(bucket({ key: 'claude' })).trim(), 'claude');
});

test('an archive nobody named is called by its profile, kind, date and time', async () => {
  const { defaultBackupName } = await import('../src/index.js');
  assert.equal(defaultBackupName('Main', 'scheduled', new Date(2026, 8, 16, 14, 5)), 'Main_auto_2026-09-16_14-05.zip');
  assert.equal(defaultBackupName('Main', 'before-restore', new Date(2026, 0, 2, 9, 30)), 'Main_before-restore_2026-01-02_09-30.zip');
});

test('an archive from before kinds were recorded is classified by its old name', async () => {
  const { backupKind } = await import('../src/index.js');
  assert.equal(backupKind({ name: 'Main-scheduled.zip', source: 'created' }), 'scheduled');
  assert.equal(backupKind({ name: 'Main-prerestore.zip', source: 'created' }), 'before-restore');
  assert.equal(backupKind({ name: 'Main-preswitch.zip', source: 'created' }), 'before-switch');
  assert.equal(backupKind({ name: 'Main-r2-abc123.zip', source: 'uploaded' }), 'r2');
  assert.equal(backupKind({ name: 'export.zip', source: 'uploaded' }), 'uploaded');
  assert.equal(backupKind({ name: 'before update.zip', source: 'created' }), 'manual');
  assert.equal(backupKind({ name: 'x.zip', source: 'created', kind: 'r2' }), 'r2');
});
