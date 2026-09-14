import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyQuery,
  initialQuery,
  pageCountFor,
  pageWindow,
  PAGE_GAP,
  queryToSearchParams,
  toggleSort,
  withPage,
  withPageSize,
  withSearch,
} from '../src/table-model.js';

interface Backup {
  readonly name: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly note?: string | null;
}

const backups: readonly Backup[] = [
  { name: 'nightly', createdAt: '2026-03-01T00:00:00Z', sizeBytes: 300 },
  { name: 'Alpha', createdAt: '2026-01-01T00:00:00Z', sizeBytes: 100, note: 'first' },
  { name: 'beta', createdAt: '2026-02-01T00:00:00Z', sizeBytes: 200, note: null },
];

const options = {
  searchText: (row: Backup) => `${row.name} ${row.note ?? ''}`,
  sortValue: (row: Backup, column: string) =>
    column === 'name' ? row.name : column === 'size' ? row.sizeBytes : row.createdAt,
};

test('sorting by name ignores case and by size compares numerically', () => {
  const byName = applyQuery(backups, { ...initialQuery(), sort: 'name' }, options);
  assert.deepEqual(byName.rows.map((row) => row.name), ['Alpha', 'beta', 'nightly']);

  const bySizeDescending = applyQuery(backups, { ...initialQuery(), sort: 'size', direction: 'desc' }, options);
  assert.deepEqual(bySizeDescending.rows.map((row) => row.sizeBytes), [300, 200, 100]);
});

test('search matches any searchable text and is case-insensitive', () => {
  const result = applyQuery(backups, withSearch(initialQuery(), 'FIRST'), options);
  assert.deepEqual(result.rows.map((row) => row.name), ['Alpha']);
  assert.equal(result.total, 1);
});

test('a search with no options set returns every row rather than none', () => {
  const result = applyQuery(backups, withSearch(initialQuery(), 'anything'), {});
  assert.equal(result.total, 3);
});

test('paging reports the total before paging and never returns an empty page past the end', () => {
  const query = { ...initialQuery(), pageSize: 2, page: 2, sort: 'size' };
  const second = applyQuery(backups, query, options);
  assert.equal(second.total, 3);
  assert.equal(second.pageCount, 2);
  assert.deepEqual(second.rows.map((row) => row.sizeBytes), [300]);

  // Asking for a page past the end shows the last one instead of nothing.
  const past = applyQuery(backups, { ...query, page: 9 }, options);
  assert.equal(past.page, 2);
  assert.equal(past.rows.length, 1);
});

test('an empty list still has one page to show its empty state in', () => {
  const result = applyQuery([], initialQuery(), options);
  assert.deepEqual(result, { rows: [], total: 0, pageCount: 1, page: 1 });
  assert.equal(pageCountFor(0, 10), 1);
});

test('rows with no value for the sorted column sort last in both directions', () => {
  const rows = [{ name: 'has' }, { name: null }, { name: 'also' }] as const;
  const sortValue = (row: { readonly name: string | null }) => row.name;
  const ascending = applyQuery(rows, { ...initialQuery(), sort: 'name' }, { sortValue });
  const descending = applyQuery(rows, { ...initialQuery(), sort: 'name', direction: 'desc' }, { sortValue });
  assert.equal(ascending.rows.at(-1)?.name, null);
  assert.equal(descending.rows.at(-1)?.name, null);
});

test('pressing a header sorts it, pressing it again flips it, and either returns to page one', () => {
  const onPageFour = withPage(initialQuery(), 4);
  const sorted = toggleSort(onPageFour, 'name');
  assert.deepEqual(
    { sort: sorted.sort, direction: sorted.direction, page: sorted.page },
    { sort: 'name', direction: 'asc', page: 1 },
  );

  const flipped = toggleSort(withPage(sorted, 3), 'name');
  assert.equal(flipped.direction, 'desc');
  assert.equal(flipped.page, 1);

  const other = toggleSort(flipped, 'size');
  assert.deepEqual({ sort: other.sort, direction: other.direction }, { sort: 'size', direction: 'asc' });
});

test('changing the search or the page size returns to page one', () => {
  assert.equal(withSearch(withPage(initialQuery(), 5), 'x').page, 1);
  assert.equal(withPageSize(withPage(initialQuery(), 5), 25).page, 1);
  assert.equal(withPageSize(initialQuery(), 0).pageSize, 1);
  assert.equal(withPage(initialQuery(), -3).page, 1);
});

test('the page window keeps a constant width and always reaches the first and last page', () => {
  assert.deepEqual(pageWindow(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageWindow(1, 20), [1, 2, 3, 4, 5, PAGE_GAP, 20]);
  assert.deepEqual(pageWindow(10, 20), [1, PAGE_GAP, 9, 10, 11, PAGE_GAP, 20]);
  assert.deepEqual(pageWindow(20, 20), [1, PAGE_GAP, 16, 17, 18, 19, 20]);
  for (const page of [1, 2, 7, 10, 14, 19, 20]) {
    const slots = pageWindow(page, 20);
    assert.equal(slots.length, 7, `page ${page} changed the control width`);
    assert.equal(slots.at(0), 1);
    assert.equal(slots.at(-1), 20);
    assert.ok(slots.includes(page), `page ${page} is not reachable from its own window`);
  }
});

test('a server-backed table sends the same query as search parameters', () => {
  const query = { page: 3, pageSize: 25, search: '  nightly  ', sort: 'size', direction: 'desc' } as const;
  assert.equal(queryToSearchParams(query).toString(), 'page=3&pageSize=25&q=nightly&sort=size&direction=desc');
  assert.equal(queryToSearchParams(initialQuery()).toString(), 'page=1&pageSize=10');
});
