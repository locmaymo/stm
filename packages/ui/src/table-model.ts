/**
 * What a table is looking at, and how to apply that to rows held in memory.
 *
 * The same shape describes both kinds of table in this console. A list the
 * browser already holds - the backups of one profile, the recovery points in a
 * bucket - is narrowed here. A list the server owns sends the identical query
 * as search parameters and answers with one page plus a total. Keeping one
 * shape means a table can be moved from one to the other without the component
 * that renders it changing at all.
 *
 * It is deliberately free of React so it can be tested directly.
 */

export type SortDirection = 'asc' | 'desc';

export interface TableQuery {
  /** One-based, because it is shown to a person. */
  readonly page: number;
  readonly pageSize: number;
  readonly search: string;
  readonly sort: string | null;
  readonly direction: SortDirection;
}

export interface TableResult<Row> {
  readonly rows: readonly Row[];
  /** Rows matching the search, before paging. */
  readonly total: number;
  readonly pageCount: number;
  /** The page actually shown, which can differ from the one asked for. */
  readonly page: number;
}

export const DEFAULT_PAGE_SIZE = 10;

export function initialQuery(overrides: Partial<TableQuery> = {}): TableQuery {
  return {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    search: '',
    sort: null,
    direction: 'asc',
    ...overrides,
  };
}

/**
 * Turn a column header press into the next query.
 *
 * Pressing the sorted column flips its direction; pressing a different one
 * starts it ascending. Either way the view returns to page one, because
 * staying on page four of a list that has just been reordered shows rows that
 * have nothing to do with what was pressed.
 */
export function toggleSort(query: TableQuery, column: string): TableQuery {
  if (query.sort !== column) return { ...query, sort: column, direction: 'asc', page: 1 };
  return { ...query, direction: query.direction === 'asc' ? 'desc' : 'asc', page: 1 };
}

/** Typing in the search box also returns to page one, for the same reason. */
export function withSearch(query: TableQuery, search: string): TableQuery {
  return { ...query, search, page: 1 };
}

export function withPageSize(query: TableQuery, pageSize: number): TableQuery {
  return { ...query, pageSize: Math.max(1, Math.trunc(pageSize)), page: 1 };
}

export function withPage(query: TableQuery, page: number): TableQuery {
  return { ...query, page: Math.max(1, Math.trunc(page)) };
}

/** How many pages a total needs. An empty list still has one page, to show its empty state in. */
export function pageCountFor(total: number, pageSize: number): number {
  if (pageSize < 1) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export interface ApplyOptions<Row> {
  /** Text pulled out of a row for the search box to match against. */
  readonly searchText?: (row: Row) => string;
  /** Value a column sorts on. Strings compare by locale, everything else naturally. */
  readonly sortValue?: (row: Row, column: string) => string | number | boolean | null | undefined;
}

/**
 * Narrow, order and cut a list the browser already holds.
 *
 * A page beyond the end is pulled back to the last one rather than rendering
 * nothing: deleting the only row on page three should show page two, not an
 * empty table with no way back.
 */
export function applyQuery<Row>(
  rows: readonly Row[],
  query: TableQuery,
  options: ApplyOptions<Row> = {},
): TableResult<Row> {
  const needle = query.search.trim().toLocaleLowerCase();
  const searchText = options.searchText;
  const matched = needle === '' || searchText === undefined
    ? [...rows]
    : rows.filter((row) => searchText(row).toLocaleLowerCase().includes(needle));

  const { sort, direction } = query;
  const sortValue = options.sortValue;
  if (sort !== null && sortValue !== undefined) {
    const sign = direction === 'asc' ? 1 : -1;
    matched.sort((left, right) => {
      const leftValue = sortValue(left, sort);
      const rightValue = sortValue(right, sort);
      // The missing check sits outside the direction, so a row with nothing to
      // sort on stays at the bottom instead of taking over the first page the
      // moment the column is reversed.
      const leftMissing = leftValue === null || leftValue === undefined;
      const rightMissing = rightValue === null || rightValue === undefined;
      if (leftMissing || rightMissing) {
        return leftMissing && rightMissing ? 0 : leftMissing ? 1 : -1;
      }
      return sign * compareDefined(leftValue, rightValue);
    });
  }

  const pageCount = pageCountFor(matched.length, query.pageSize);
  const page = Math.min(Math.max(1, query.page), pageCount);
  const start = (page - 1) * query.pageSize;
  return {
    rows: matched.slice(start, start + query.pageSize),
    total: matched.length,
    pageCount,
    page,
  };
}

/**
 * Compare two values that are both present.
 *
 * Text compares by locale with numeric collation, so "backup 2" comes before
 * "backup 10" and Vietnamese diacritics order the way a reader expects.
 */
function compareDefined(
  left: string | number | boolean,
  right: string | number | boolean,
): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) return 0;
  return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
}

/** A gap in the page numbers, rendered as an ellipsis. */
export const PAGE_GAP = 'gap';
export type PageSlot = number | typeof PAGE_GAP;

/**
 * The page numbers to offer, with gaps where there are too many to show.
 *
 * The first and last page are always reachable, and the window around the
 * current page keeps a constant width so the buttons do not move under a
 * finger while paging through.
 */
export function pageWindow(page: number, pageCount: number, maxSlots = 7): readonly PageSlot[] {
  const total = Math.max(1, Math.trunc(pageCount));
  const current = Math.min(Math.max(1, Math.trunc(page)), total);
  const slots = Math.max(5, Math.trunc(maxSlots));
  if (total <= slots) return range(1, total);

  const side = Math.floor((slots - 3) / 2);
  if (current <= side + 2) return [...range(1, slots - 2), PAGE_GAP, total];
  if (current >= total - side - 1) return [1, PAGE_GAP, ...range(total - slots + 3, total)];
  return [1, PAGE_GAP, ...range(current - side + 1, current + side - 1), PAGE_GAP, total];
}

function range(from: number, to: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += 1) values.push(value);
  return values;
}

/** The query as search parameters, for a table whose rows the server owns. */
export function queryToSearchParams(query: TableQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.search.trim() !== '') params.set('q', query.search.trim());
  if (query.sort !== null) {
    params.set('sort', query.sort);
    params.set('direction', query.direction);
  }
  return params;
}
