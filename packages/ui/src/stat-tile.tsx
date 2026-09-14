import type { ComponentProps, ReactNode } from 'react';
import { Card, CardContent } from './shadcn/card.js';
import { cn } from './shadcn/utils.js';

export interface StatTileProps extends Omit<ComponentProps<'div'>, 'title'> {
  readonly icon?: ReactNode;
  readonly label: string;
  /** Already formatted. A tile never decides how a number is written. */
  readonly value: string;
  /** One short line under the number, when the number needs a denominator. */
  readonly hint?: string;
  /** What belongs beside the number: a breakdown button, usually. */
  readonly action?: ReactNode;
}

/**
 * One number, said once.
 *
 * The metrics page had grown a general tile and then a second, taller one just
 * for tokens, with its own type scale, its own disclosure triangle and its own
 * pair of arrows - so four numbers on one row were written four different
 * sizes. This is the one shape, and anything extra goes in `action` rather
 * than into a new variant.
 *
 * The number is the largest thing in the tile and comes after its label in the
 * markup, so a screen reader reads "Requests, 1,204" rather than a bare figure.
 */
export function StatTile({ icon, label, value, hint, action, className, ...props }: StatTileProps) {
  return (
    <Card className={cn('gap-0 py-4 shadow-none', className)} {...props}>
      <CardContent className="grid gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-primary">
            {icon}
            <span className="truncate">{label}</span>
          </span>
          {action ? <span className="ml-auto shrink-0">{action}</span> : null}
        </div>
        <strong className="truncate text-2xl leading-tight font-semibold tabular-nums" title={value}>
          {value}
        </strong>
        {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
      </CardContent>
    </Card>
  );
}
