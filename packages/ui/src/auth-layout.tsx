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
 *
 * Two lights rather than one. A single band across the top reads as a gradient
 * that ran out halfway; a second, weaker one below gives the card a middle to
 * sit in rather than floating on flat paint.
 */
export function AuthLayout({ title, subtitle, children, controls, footer, className }: AuthLayoutProps) {
  return (
    <div
      data-slot="auth-layout"
      className={cn(
        'relative isolate flex min-h-[100dvh] flex-col items-center justify-center gap-7 px-4 py-12',
        'before:pointer-events-none before:absolute before:inset-0 before:-z-10',
        'before:bg-[radial-gradient(44rem_26rem_at_50%_-5rem,color-mix(in_srgb,var(--primary)_17%,transparent),transparent_70%),radial-gradient(34rem_22rem_at_50%_112%,color-mix(in_srgb,var(--primary)_9%,transparent),transparent_70%)]',
        className,
      )}
    >
      {controls ? <div className="absolute inset-x-0 top-0 flex justify-end gap-1.5 p-3">{controls}</div> : null}
      <div className="relative flex w-full max-w-sm flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          {/* Neither rounded nor boxed. The artwork is already a disc with a
              flag badge hanging off its lower corner, and a rounded square cut
              the badge clean off. A drop shadow follows the shape it has. */}
          <BrandMark size={64} className="drop-shadow-[0_0.5rem_1.25rem_color-mix(in_srgb,var(--primary)_30%,transparent)]" />
          <div className="grid gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
            {subtitle ? <p className="text-sm text-balance text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        {children}
        {footer ? <div className="text-center text-xs text-balance text-muted-foreground">{footer}</div> : null}
      </div>
    </div>
  );
}
