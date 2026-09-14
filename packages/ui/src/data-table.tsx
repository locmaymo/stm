import { useMemo, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from 'lucide-react';
import { Input } from './shadcn/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './shadcn/select.js';
import { Skeleton } from './shadcn/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './shadcn/table.js';
import { cn } from './shadcn/utils.js';
import { EmptyState } from './empty-state.js';
import { Pagination, type PaginationLabels } from './pagination.js';
import { applyQuery, toggleSort, withPage, withPageSize, withSearch, type TableQuery } from './table-model.js';

export interface DataTableColumn<Row> {
  /** Stable key. Also the sort key sent to a server-backed table. */
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly sortable?: boolean;
  /** Text alignment for both the header and the cells. */
  readonly align?: 'start' | 'end';
  /**
   * Hide below this breakpoint. A phone shows the two or three columns that
   * matter; the rest return with the width to hold them.
   */
  readonly showFrom?: 'sm' | 'md' | 'lg';
  readonly className?: string;
  /** Header cell width, e.g. `w-24`. */
  readonly headClassName?: string;
}

export interface DataTableLabels extends PaginationLabels {
  readonly search: string;
  readonly perPage: string;
  /** Rendered as `count(shown, total)`, so a locale can order the words itself. */
  readonly count: (shown: number, total: number) => string;
  readonly sortAscending: string;
  readonly sortDescending: string;
}

export interface DataTableProps<Row> {
  readonly rows: readonly Row[];
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rowKey: (row: Row) => string;
  readonly query: TableQuery;
  readonly onQueryChange: (query: TableQuery) => void;
  readonly labels: DataTableLabels;
  /** Text the search box matches against. Omit to hide the search box. */
  readonly searchText?: (row: Row) => string;
  readonly sortValue?: (row: Row, column: string) => string | number | boolean | null | undefined;
  /**
   * Pass a total when the server already narrowed and paged the rows. The rows
   * given are then rendered as they arrive, and only the controls are driven
   * from the query.
   */
  readonly total?: number;
  readonly loading?: boolean;
  readonly empty?: ReactNode;
  /** Controls that belong to this table, shown beside the search box. */
  readonly toolbar?: ReactNode;
  readonly pageSizes?: readonly number[];
  readonly className?: string;
}

const showFromClass = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const;

/**
 * One table, for every list in the console.
 *
 * Search, sort, page size and paging are the same controls in the same places
 * whether the rows are already in the browser or come a page at a time from
 * the server - the difference is only whether `total` is passed. Before this,
 * each list had grown its own arrangement of rows in a flex column with its
 * own buttons, its own empty sentence, and no way to find anything in a long
 * one.
 */
export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  query,
  onQueryChange,
  labels,
  searchText,
  sortValue,
  total,
  loading = false,
  empty,
  toolbar,
  pageSizes = [10, 25, 50],
  className,
}: DataTableProps<Row>) {
  const serverSide = total !== undefined;

  const view = useMemo(() => {
    if (serverSide) {
      const pageCount = Math.max(1, Math.ceil(total / Math.max(1, query.pageSize)));
      return { rows, total, pageCount, page: Math.min(query.page, pageCount) };
    }
    return applyQuery(rows, query, {
      ...(searchText ? { searchText } : {}),
      ...(sortValue ? { sortValue } : {}),
    });
  }, [serverSide, rows, total, query, searchText, sortValue]);

  const columnCount = columns.length;

  return (
    <div className={cn('grid gap-3', className)}>
      {searchText || toolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {searchText ? (
            // Full width on a phone, so the controls beside it wrap to their own
            // row rather than being squeezed into what the search box leaves.
            <div className="relative min-w-0 flex-1 basis-full sm:basis-auto sm:max-w-xs">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                className="pl-8"
                placeholder={labels.search}
                aria-label={labels.search}
                value={query.search}
                onChange={(event) => onQueryChange(withSearch(query, event.target.value))}
              />
            </div>
          ) : null}
          {toolbar}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => {
                const sorted = query.sort === column.id;
                const nextLabel = sorted && query.direction === 'asc' ? labels.sortDescending : labels.sortAscending;
                return (
                  <TableHead
                    key={column.id}
                    scope="col"
                    aria-sort={sorted ? (query.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn(
                      column.align === 'end' && 'text-right',
                      column.showFrom && showFromClass[column.showFrom],
                      column.headClassName,
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        aria-label={`${typeof column.header === 'string' ? `${column.header}: ` : ''}${nextLabel}`}
                        onClick={() => onQueryChange(toggleSort(query, column.id))}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                          column.align === 'end' && 'flex-row-reverse',
                          sorted && 'text-foreground',
                        )}
                      >
                        {column.header}
                        {sorted ? (
                          query.direction === 'asc' ? (
                            <ArrowUp className="size-3.5" />
                          ) : (
                            <ArrowDown className="size-3.5" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-50" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 3 }, (_unused, index) => (
                <TableRow key={`skeleton-${index}`} className="hover:bg-transparent">
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      className={cn(column.showFrom && showFromClass[column.showFrom])}
                    >
                      <Skeleton className="h-4 w-full max-w-40" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : view.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="p-0">
                  {empty ?? <EmptyState title={labels.count(0, 0)} />}
                </TableCell>
              </TableRow>
            ) : (
              view.rows.map((row) => (
                <TableRow key={rowKey(row)}>
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      className={cn(
                        column.align === 'end' && 'text-right',
                        column.showFrom && showFromClass[column.showFrom],
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {view.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" role="status">
            {labels.count(view.rows.length, view.total)}
          </p>
          <div className="flex items-center gap-2">
            {view.total > Math.min(...pageSizes) ? (
              <Select
                value={String(query.pageSize)}
                onValueChange={(value) => onQueryChange(withPageSize(query, Number(value)))}
              >
                <SelectTrigger size="sm" aria-label={labels.perPage} className="w-auto gap-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pageSizes.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Pagination
              page={view.page}
              pageCount={view.pageCount}
              onPageChange={(page) => onQueryChange(withPage(query, page))}
              labels={labels}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
