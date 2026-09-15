import { useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cloneElement, isValidElement } from 'react';
import { Label } from './shadcn/label.js';
import { cn } from './shadcn/utils.js';

export interface FieldProps extends Omit<ComponentProps<'div'>, 'children'> {
  readonly label: ReactNode;
  /** One short line under the control. Leave it out when the label already says it. */
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
}

/**
 * One labelled control, wired up.
 *
 * Panels across the console had each grown their own arrangement of a label, a
 * control and a message, which is why fields sat at different heights in
 * different cards and why some errors were announced and others were not. The
 * identifiers here are generated and attached, so a label always points at its
 * control and an error is always read out with it.
 */
export function Field({ label, hint, error, required, children, className, ...props }: FieldProps) {
  const generated = useId();
  const controlId = children.props.id ?? `${generated}-control`;
  const hintId = hint ? `${generated}-hint` : undefined;
  const errorId = error ? `${generated}-error` : undefined;
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ');

  const control = isValidElement(children)
    ? cloneElement(children, {
      id: controlId,
      ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
      ...(error ? { 'aria-invalid': true } : {}),
    })
    : children;

  return (
    <div className={cn('grid gap-1.5', className)} {...props}>
      <Label htmlFor={controlId} className="text-sm font-medium text-foreground">
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
