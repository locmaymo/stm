import { useId, useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './shadcn/input.js';
import { cn } from './shadcn/utils.js';

export interface PasswordInputProps extends Omit<ComponentProps<'input'>, 'type'> {
  /** Labels for the reveal control, so the component carries no English of its own. */
  readonly revealLabel: string;
  readonly hideLabel: string;
}

/**
 * A password field that can be read back.
 *
 * Every password in this console is typed on a phone, on a keyboard that
 * autocorrects, into a field that answers with dots - and getting it wrong
 * means being locked out of the thing being set up. Being able to look at what
 * was typed is worth more here than hiding it from a room.
 */
export function PasswordInput({ revealLabel, hideLabel, className, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const describedBy = useId();
  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        className={cn('pr-10', className)}
        // Password managers and the browser's own generator key off these, and
        // getting them wrong is what makes a field offer last week's search.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        {...props}
      />
      <button
        type="button"
        aria-label={visible ? hideLabel : revealLabel}
        aria-pressed={visible}
        aria-controls={describedBy}
        // Not focusable by tab: it sits between the field and the submit
        // button, and stopping there on the way to signing in helps nobody.
        tabIndex={-1}
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4"
      >
        {visible ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}
