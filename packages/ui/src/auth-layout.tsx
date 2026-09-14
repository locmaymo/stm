import type { ReactNode } from 'react';
import { BrandMark } from './brand.js';
import { cn } from './shadcn/utils.js';

export interface AuthLayoutProps {
  readonly title: ReactNode;
  /** One line under the title. The screen has room for it; the pages do not. */
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  /** Language and theme, in the corner. Read before the form, used before signing in. */
  readonly controls?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * The screen the manager is met on.
 *
 * This is the first thing anyone sees and, for the length of a first run, the
 * only thing - so it carries the mark and says what the product is, rather
 * than presenting an unlabelled password box on an empty page. The card is
 * narrow on purpose: one column of fields reads the same on a phone and on a
 * desktop, and there is nothing here to put in a second column.
 *
 * `100dvh` rather than `100vh` because the mobile browser chrome slides away;
 * with `vh` the submit button sat under the address bar until the page was
 * scrolled, on the one screen where the button is the entire point.
 */
export function AuthLayout({ title, subtitle, children, controls, footer, className }: AuthLayoutProps) {
  return (
    <div
      data-slot="auth-layout"
      className={cn(
        'relative flex min-h-[100dvh] flex-col items-center justify-center gap-6 px-4 py-10',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-64',
        'before:bg-[radial-gradient(60rem_20rem_at_50%_-6rem,color-mix(in_srgb,var(--primary)_14%,transparent),transparent)]',
        className,
      )}
    >
      {controls ? <div className="absolute inset-x-0 top-0 flex justify-end gap-1.5 p-3">{controls}</div> : null}
      <div className="relative flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark size={56} className="rounded-2xl shadow-[var(--elevation-2)]" />
          <div className="grid gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="text-sm text-balance text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        {children}
        {footer ? <div className="text-center text-xs text-muted-foreground">{footer}</div> : null}
      </div>
    </div>
  );
}
