import type { ComponentProps, ReactNode } from 'react';
import { cn } from './shadcn/utils.js';

export interface EmptyStateProps extends ComponentProps<'div'> {
  readonly icon?: ReactNode;
  readonly title: string;
  /**
   * One short line, and only when the title genuinely cannot say it. Most empty
   * states need no description at all.
   */
  readonly description?: string;
  /** The one action that fills this emptiness, if there is one. */
  readonly action?: ReactNode;
}

/**
 * What a list looks like before it has anything in it.
 *
 * Every list in the console uses this rather than its own sentence in its own
 * size in its own place, which is how "No backup yet", "No profiles yet" and
 * "No recovery points" ended up looking like three different products.
 */
export function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-balance text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
