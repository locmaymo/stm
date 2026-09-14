import type { ComponentType, ReactNode } from 'react';
import { cn } from './shadcn/utils.js';

export interface MobileNavItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon: ComponentType<{ className?: string }>;
  readonly href: string;
}

export interface MobileNavProps {
  readonly items: readonly MobileNavItem[];
  readonly current: string;
  readonly onNavigate: (id: string) => void;
  readonly label: string;
}

/**
 * The four destinations, along the bottom, on a phone.
 *
 * Reaching a page used to cost three actions: find the hamburger in the top
 * left, wait for a sheet, tap, and watch it close again - all at the far end
 * of the screen from where a thumb rests. With only four destinations there is
 * no reason to hide them at all. The sidebar is still the desktop navigation;
 * this replaces the sheet below `md`, and the trigger for it goes with it.
 */
export function MobileNav({ items, current, onNavigate, label }: MobileNavProps) {
  return (
    <nav
      aria-label={label}
      data-slot="mobile-nav"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="flex items-stretch">
        {items.map(({ id, label: itemLabel, icon: Icon, href }) => {
          const active = id === current;
          return (
            <li key={id} className="flex-1">
              <a
                href={href}
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(id)}
                className={cn(
                  // 60px of height, so the target is comfortably past the 44px
                  // minimum even with the label under the icon.
                  'flex h-[3.75rem] flex-col items-center justify-center gap-1 px-1 text-[0.6875rem] font-medium outline-none transition-colors',
                  'focus-visible:bg-accent',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className={cn('size-5 shrink-0', active && 'stroke-[2.25]')} />
                <span className="max-w-full truncate">{itemLabel}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
