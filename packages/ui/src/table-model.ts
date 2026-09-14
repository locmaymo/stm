/**
 * What a table is looking at, from the component's side.
 *
 * The query shape, the sorting and the paging live in `packages/contracts`,
 * because the server narrows server-owned lists from the same query and the
 * two have to agree down to how accents collate. What stays here is what only
 * a component needs: turning a header press or a search keystroke into the
 * next query, and working out which page numbers to draw.
 *
 * It is deliberately free of React so it can be tested directly.
 */

export {
  applyQuery,
  compareDefined,
  pageCountFor,
  parseTableQuery,
  queryToSearchParams,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ApplyOptions,
  type PageInfo,
  type SortDirection,
  type TableQuery,
  type TableResult,
} from '../../contracts/src/table-query.js';

import { DEFAULT_PAGE_SIZE, type TableQuery } from '../../contracts/src/table-query.js';

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
