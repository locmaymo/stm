import type { ComponentProps } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './shadcn/button.js';
import { cn } from './shadcn/utils.js';
import { PAGE_GAP, pageWindow } from './table-model.js';

export interface PaginationProps extends Omit<ComponentProps<'nav'>, 'onChange'> {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  readonly labels: PaginationLabels;
}

export interface PaginationLabels {
  readonly navigation: string;
  readonly previous: string;
  readonly next: string;
  /** Rendered as `page(n, of)`, so a locale can order the words itself. */
  readonly page: (page: number, of: number) => string;
}

/**
 * Page controls that keep their place.
 *
 * The number of buttons never changes as the pages advance, so the one under a
 * finger stays where it was. Numbers are hidden below `sm` because seven small
 * targets in a row on a phone is a lottery; the arrows and the count remain.
 */
export function Pagination({ page, pageCount, onPageChange, labels, className, ...props }: PaginationProps) {
  if (pageCount <= 1) return null;
  const slots = pageWindow(page, pageCount);
  return (
    <nav aria-label={labels.navigation} className={cn('flex items-center gap-1', className)} {...props}>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={labels.previous}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft />
      </Button>
      <span className="px-2 text-xs whitespace-nowrap text-muted-foreground sm:hidden">
        {labels.page(page, pageCount)}
      </span>
      <ul className="hidden items-center gap-1 sm:flex">
        {slots.map((slot, index) => (
          <li key={slot === PAGE_GAP ? `gap-${index}` : slot}>
            {slot === PAGE_GAP ? (
              <span aria-hidden="true" className="grid size-8 place-items-center text-muted-foreground">
                &hellip;
              </span>
            ) : (
              <Button
                variant={slot === page ? 'default' : 'ghost'}
                size="icon-sm"
                aria-label={labels.page(slot, pageCount)}
                aria-current={slot === page ? 'page' : undefined}
                onClick={() => onPageChange(slot)}
              >
                {slot}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={labels.next}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight />
      </Button>
    </nav>
  );
}
