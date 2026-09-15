import { useId, useRef, type ComponentProps } from 'react';
import { Delete, X } from 'lucide-react';
import { cn } from './shadcn/utils.js';

export interface PasscodeLabels {
  /** `{n}` is replaced with the digit. */
  readonly digit: string;
  readonly clear: string;
  readonly backspace: string;
}

export interface PasscodeInputProps extends Omit<ComponentProps<'div'>, 'onChange' | 'children'> {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Called when the last digit lands, so a form can submit itself. */
  readonly onComplete?: (value: string) => void;
  readonly label: string;
  readonly length?: number;
  readonly labels: PasscodeLabels;
  readonly autoFocus?: boolean;
  readonly disabled?: boolean;
}

/**
 * A passcode, entered the way a phone asks for one.
 *
 * The digits are dots and the keys are buttons, and the field behind them is
 * an ordinary input kept off-screen rather than hidden: a physical keyboard
 * still types into it, a screen reader still announces its label, and focus
 * still lands somewhere real.
 *
 * The public sign-in page draws the same thing in plain HTML, because it is
 * served by the gateway with no bundler and has to work before any script
 * runs. Two implementations of one idea is the cost of that; the shape and
 * the labels are kept the same so it is one thing to the person using it.
 */
export function PasscodeInput({
  value,
  onChange,
  onComplete,
  label,
  length = 6,
  labels,
  autoFocus,
  disabled,
  className,
  ...props
}: PasscodeInputProps) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);

  const set = (next: string) => {
    const digits = next.replace(/[^0-9]/gu, '').slice(0, length);
    onChange(digits);
    if (digits.length === length) onComplete?.(digits);
  };

  const press = (key: string) => {
    if (key === 'clear') set('');
    else if (key === 'back') set(value.slice(0, -1));
    else set(value + key);
    field.current?.focus();
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className={cn('grid gap-4', className)} {...props}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        ref={field}
        id={id}
        className="sr-only"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        disabled={disabled}
        {...(autoFocus === undefined ? {} : { autoFocus })}
        onChange={(event) => set(event.target.value)}
      />
      <div className="flex justify-center gap-3" aria-hidden="true">
        {Array.from({ length }, (_unused, index) => (
          <span
            key={index}
            className={cn(
              'size-3.5 rounded-full border transition-[background-color,transform] motion-reduce:transition-none',
              index < value.length ? 'scale-110 border-primary bg-primary' : 'border-input',
            )}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-label={labels.digit.replace('{n}', key)}
            onClick={() => press(key)}
            className="h-13 rounded-lg border bg-card text-xl font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent disabled:opacity-50"
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          aria-label={labels.clear}
          onClick={() => press('clear')}
          className="grid h-13 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <X className="size-5" />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label={labels.digit.replace('{n}', '0')}
          onClick={() => press('0')}
          className="h-13 rounded-lg border bg-card text-xl font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent disabled:opacity-50"
        >
          0
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label={labels.backspace}
          onClick={() => press('back')}
          className="grid h-13 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <Delete className="size-5" />
        </button>
      </div>
    </div>
  );
}
