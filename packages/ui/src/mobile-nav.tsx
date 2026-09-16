import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
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

/** Past this the gap is an on-screen keyboard, which the bar should stay under. */
const MAX_TOOLBAR_GAP = 120;

/**
 * How far the bottom of what is visible sits above the bottom of the layout.
 *
 * A fixed bar is pinned to the layout viewport, and Chrome on Android lets
 * that fall out of step with the screen when its toolbar slides - most often
 * after a dialog has locked and released the page's scroll. The bar then sits
 * below the visible area until the page is scrolled to its very end. Lifting
 * it by the gap keeps it on the glass whichever way the two disagree.
 */
export function useViewportBottomGap(): number {
  const [gap, setGap] = useState(0);
  useEffect(() => {
    const viewport = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (!viewport) return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        const typing = active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(active.tagName));
        // A pinched page is meant to move under the bar, and a keyboard is
        // meant to cover it.
        if (viewport.scale > 1.01 || typing) { setGap(0); return; }
        const next = Math.round(window.innerHeight - (viewport.height + viewport.offsetTop));
        setGap(next > 0 && next <= MAX_TOOLBAR_GAP ? next : 0);
      });
    };
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
      window.removeEventListener('scroll', measure);
    };
  }, []);
  return gap;
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
  const gap = useViewportBottomGap();
  return (
    <nav
      aria-label={label}
      data-slot="mobile-nav"
      style={gap > 0 ? { transform: `translateY(-${gap}px)` } : undefined}
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
