import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, Button, Card, CardContent, cn } from '../../../packages/ui/src/index.js';
import type { Translate } from './i18n.js';

export interface ChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly done: boolean;
  readonly onSelect: () => void;
}

/**
 * What is left to do before this machine is set up properly, as a list.
 *
 * Each of these used to be found by reading the page - a pill here, a
 * warning there, a switch that was off - and nothing said which of them were
 * still to do or in what order. The list says it in one place, in the order
 * they are best done - a row stays where it is once it is done, so the list
 * reads the same every time - and takes the reader to the rest.
 *
 * Open while anything is left, on every load: folding it is for now, not for
 * good, because a list that stays folded is a list nobody finishes. Once
 * everything is crossed off it folds itself, and keeps its title and count.
 */
export function SetupChecklist({ t, items }: { t: Translate; items: readonly ChecklistItem[] }) {
  const done = items.filter((item) => item.done).length;
  const complete = done === items.length;
  // Null until somebody presses the header; until then it follows the list.
  const [folded, setFolded] = useState<boolean | null>(null);
  const collapsed = folded ?? complete;
  const toggle = () => { setFolded(!collapsed); };
  /*
   * On a phone the list is a short window that scrolls, faded at whichever
   * edge has more beyond it - three rows and most of a fourth, rather than
   * six rows of card between the reader and the rest of the page. The ends
   * are measured, so a list scrolled to the bottom stops fading there.
   */
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = () => {
    const element = scroller.current;
    if (!element) return;
    setEdges({ top: element.scrollTop > 2, bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 2 });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [collapsed, done]);

  return <Card className="checklist gap-0 py-0">
    <div className="flex items-center gap-2 px-4 py-3">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={toggle} aria-expanded={!collapsed}>
        <span className="truncate text-[15px] font-semibold">{t('console.checklistTitle')}</span>
        <Badge variant="secondary" className={cn('tabular-nums', complete && 'bg-(--success-background) text-(--success)')}>{done}/{items.length}</Badge>
        {complete ? <Check className="size-4 text-(--success)" aria-hidden="true" /> : null}
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={collapsed ? t('console.checklistExpand') : t('console.checklistCollapse')} onClick={toggle}>
        <ChevronDown className={cn('transition-transform', collapsed ? '-rotate-90' : '')} />
      </Button>
    </div>
    {collapsed ? null : <CardContent ref={scroller} onScroll={measure} className="checklist-list grid gap-2 px-3 pb-3 sm:grid-cols-2" data-fade-top={edges.top || undefined} data-fade-bottom={edges.bottom || undefined}>
      {complete ? <p className="px-1 pb-1 text-sm text-(--success) sm:col-span-2">{t('console.checklistAllDone')}</p> : null}
      {items.map((item) => <button
        key={item.id}
        type="button"
        className="checklist-item"
        data-done={item.done || undefined}
        onClick={item.onSelect}
      >
        <span className="checklist-icon" aria-hidden="true">{item.icon}</span>
        <span className="checklist-label">{item.done ? <s>{item.label}</s> : item.label}</span>
        {item.done
          ? <Check className="checklist-check" aria-hidden="true" />
          : <ChevronRight className="checklist-go" aria-hidden="true" />}
      </button>)}
    </CardContent>}
  </Card>;
}
