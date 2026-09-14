import type { ReactNode } from 'react';
import { cn } from './shadcn/utils.js';

export type StatusTone = 'online' | 'offline' | 'working' | 'attention';

export interface StatusHeroProps {
  readonly tone: StatusTone;
  readonly title: ReactNode;
  /** One line under the title: a version, an address, what is being waited for. */
  readonly detail?: ReactNode;
  /** 0-100 while something is running its course; a bar appears for it. */
  readonly progress?: number | null;
  /** The one or two things worth doing from here. */
  readonly actions?: ReactNode;
}

const toneDot: Record<StatusTone, string> = {
  online: 'bg-[var(--primary)]',
  offline: 'bg-muted-foreground/50',
  working: 'bg-[var(--primary)] animate-pulse',
  attention: 'bg-[var(--attention)]',
};

/**
 * The answer to the question the page was opened to ask.
 *
 * The overview used to open with four cards of equal weight, and finding out
 * whether SillyTavern was up meant reading a badge in the corner of the first
 * one. Whether it is running, and the single most useful thing to do about
 * that, now sit above everything else at a size that can be read from across
 * the desk.
 *
 * The dot is never the only carrier of the state - the title always says it in
 * words as well, because a colour alone is no use to a reader who cannot
 * separate these two, and no use at all to a screen reader.
 */
export function StatusHero({ tone, title, detail, progress, actions }: StatusHeroProps) {
  const showProgress = typeof progress === 'number' && Number.isFinite(progress);
  return (
    <section
      data-slot="status-hero"
      data-tone={tone}
      className="flex flex-col gap-4 rounded-xl border bg-card p-(--page-gutter) shadow-[var(--elevation-1)] sm:flex-row sm:items-center sm:gap-6"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span aria-hidden="true" className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', toneDot[tone])} />
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{title}</h2>
          {detail ? <div className="min-w-0 text-sm text-muted-foreground">{detail}</div> : null}
          {showProgress ? (
            <div
              role="progressbar"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}
