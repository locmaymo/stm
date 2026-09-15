import { useEffect, useId, useRef, type ComponentProps } from 'react';
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
 * an ordinary input - not hidden away, but laid over the dots with its text
 * and its caret made transparent. That placement is the whole interaction:
 *
 *   - tapping the dots is tapping the field, so the device's own keyboard
 *     comes up, which is what tapping a place to type has always meant;
 *   - tapping a key on the keypad does not touch the field's focus, so the
 *     device's keyboard stays away. Somebody using the keypad drawn on the
 *     screen has already chosen their keyboard.
 *
 * It read the other way round first, and a system keypad sliding up over the
 * keypad being pressed is a funny thing to watch once and no fun after that.
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

  /*
   * Focus on arrival, but only where focus does not summon a keyboard.
   *
   * On a machine with a mouse the field being ready to type into is free. On
   * a phone it is a system keypad covering the one on screen before the
   * reader has touched anything.
   */
  useEffect(() => {
    if (!autoFocus) return;
    if (typeof window === 'undefined' || !window.matchMedia('(pointer: fine)').matches) return;
    field.current?.focus();
  }, [autoFocus]);

  const set = (next: string) => {
    const digits = next.replace(/[^0-9]/gu, '').slice(0, length);
    onChange(digits);
    if (digits.length === length) onComplete?.(digits);
  };

  // No `focus()` here: see the note above. The pressed key keeps the focus,
  // so the keyboard and the screen reader both still have somewhere to be.
  const press = (key: string) => {
    if (key === 'clear') set('');
    else if (key === 'back') set(value.slice(0, -1));
    else set(value + key);
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className={cn('grid gap-4', className)} {...props}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <div className="relative">
        <input
          ref={field}
          id={id}
          /* `text-base` rather than anything smaller: iOS zooms the page in on
             a field it considers too small to read, and a login screen that
             jumps when it is touched feels broken. */
          className="absolute inset-0 z-10 w-full cursor-pointer rounded-lg bg-transparent text-base text-transparent caret-transparent outline-none selection:bg-transparent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={value}
          disabled={disabled}
          onChange={(event) => set(event.target.value)}
        />
        <div className="pointer-events-none flex min-h-11 items-center justify-center gap-3" aria-hidden="true">
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
      </div>
      <div className="grid grid-cols-3 gap-2">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-label={labels.digit.replace('{n}', key)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => press(key)}
            className="h-13 touch-manipulation rounded-lg border bg-card text-xl font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent disabled:opacity-50"
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          aria-label={labels.clear}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => press('clear')}
          className="grid h-13 touch-manipulation place-items-center rounded-lg text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <X className="size-5" />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label={labels.digit.replace('{n}', '0')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => press('0')}
          className="h-13 touch-manipulation rounded-lg border bg-card text-xl font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent disabled:opacity-50"
        >
          0
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label={labels.backspace}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => press('back')}
          className="grid h-13 touch-manipulation place-items-center rounded-lg text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <Delete className="size-5" />
        </button>
      </div>
    </div>
  );
}
