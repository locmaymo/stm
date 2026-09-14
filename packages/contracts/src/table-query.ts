/**
 * What a table is looking at, and how to apply it to rows.
 *
 * This lives in the contracts because both ends need it and they have to agree.
 * A list the browser already holds is narrowed in the browser; a list the
 * server owns is narrowed on the server from the same query, sent as search
 * parameters. If the two implemented "sort by name" separately they would
 * disagree on accents, on "backup 2" against "backup 10", and on where a row
 * with nothing to sort on goes - and the disagreement would only show up when
 * a list grew past one page.
 *
 * Free of React and of `node:` imports, so both sides can use it and it can be
 * tested directly.
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

/**
 * A ceiling on what one request can ask for.
 *
 * `pageSize=100000` is not a page, it is the whole table with extra steps, and
 * on the server it is a way to make the manager walk every archive it has for
 * one careless caller.
 */
export const MAX_PAGE_SIZE = 200;

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
 * Narrow, order and cut a list.
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
export function compareDefined(
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

/**
 * Read a query back off a request, or decide there is not one.
 *
 * `null` means the caller asked for a list, not a page, and should be given
 * the whole thing. That is what every existing caller does, and a list
 * endpoint that quietly started returning the first ten rows to them would
 * lose data nobody had asked it to hide. Paging is opt-in, per request.
 */
export function parseTableQuery(params: URLSearchParams): TableQuery | null {
  const asked = ['page', 'pageSize', 'q', 'sort'].some((name) => params.has(name));
  if (!asked) return null;

  const direction = params.get('direction') === 'desc' ? 'desc' : 'asc';
  const sort = params.get('sort');
  return {
    page: boundedInteger(params.get('page'), 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: boundedInteger(params.get('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    search: params.get('q') ?? '',
    sort: sort === null || sort === '' ? null : sort,
    direction,
  };
}

function boundedInteger(raw: string | null, fallback: number, low: number, high: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  // A page of "banana" is a caller mistake, not a reason to answer with
  // nothing; it gets the default, the same as having left it out.
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, low), high);
}

/** What the answer says about the page it contains, alongside the rows. */
export interface PageInfo {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageCount: number;
}

export function pageInfo<Row>(result: TableResult<Row>, pageSize: number): PageInfo {
  return { page: result.page, pageSize, total: result.total, pageCount: result.pageCount };
}
