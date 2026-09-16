import { useState, type ReactNode } from 'react';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
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
 *
 * Once answered, the question goes. The confirm button spins for a moment so
 * it is plain the work has started, and the dialog closes after at most
 * `CLOSE_AFTER_MS` whether or not the work has finished. It used to stay open
 * until the work was done, which for saving the settings or removing
 * SillyTavern meant a restart or a directory of thousands of files later,
 * with nothing on screen but a dialog that would not go away. The work goes on
 * behind it and reports on the page and in a toast, which is where every
 * caller already reports.
 */
/** Long enough to see the button acknowledge the press, short enough not to wait on. */
const CLOSE_AFTER_MS = 450;

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

  const confirm = () => {
    setWorking(true);
    // A failure is the caller's to report; it must not leave the dialog stuck.
    const work = Promise.resolve().then(onConfirm).catch(() => undefined);
    const soon = new Promise<void>((resolve) => { setTimeout(resolve, CLOSE_AFTER_MS); });
    void Promise.race([work, soon]).then(() => {
      onOpenChange(false);
      setWorking(false);
    });
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
              // Closed by `confirm`, once the press has visibly been taken.
              event.preventDefault();
              confirm();
            }}
          >
            {working ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
