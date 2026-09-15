import { useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './shadcn/alert-dialog.js';
import { buttonVariants } from './shadcn/button.js';
import { cn } from './shadcn/utils.js';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /** What will happen, in one sentence. This is where a warning belongs. */
  readonly description?: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly tone?: 'default' | 'destructive';
  readonly busy?: boolean;
  readonly onConfirm: () => void | Promise<void>;
}

/**
 * The question asked before something cannot be undone.
 *
 * Warnings used to be printed onto the page next to the control, where they
 * were read once and then became part of the furniture. They belong here, at
 * the moment the action is actually taken, where they are the only thing on
 * screen.
 *
 * Cancel is focused when the dialog opens, so a stray Enter closes the
 * question rather than answering it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'destructive',
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [working, setWorking] = useState(false);
  const pending = busy || working;

  const confirm = async () => {
    setWorking(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setWorking(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-start gap-2.5">
            {tone === 'destructive' ? (
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : null}
            <span>{title}</span>
          </AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(tone === 'destructive' && buttonVariants({ variant: 'destructive' }))}
            disabled={pending}
            onClick={(event) => {
              // The dialog closes once the work has actually finished, so a
              // failure can still be reported against the question that caused it.
              event.preventDefault();
              void confirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
