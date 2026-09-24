// Adapted from shadcn/ui new-york-v4 (button); see THIRD_PARTY_NOTICES.md.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils.js"
import { Slot } from "radix-ui"
import { LoaderCircle } from "lucide-react"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        // Something that adds or brings up to date: installing, updating.
        success:
          "bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success/30",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * A button that says when it is working.
 *
 * Pressing something that has to wait on the manager used to leave the button
 * looking exactly as it did before the press, so it was pressed again. Now a
 * handler that returns a promise turns the button into a spinner, disabled,
 * until the promise settles - no state to thread through for it - and
 * `loading` does the same for work the caller tracks itself.
 *
 * The spinner takes the place of the button's own icon rather than sitting
 * beside it, so the button keeps its width. A button rendered `asChild` is
 * someone else's element and is left alone.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  onClick,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }) {
  const [pending, setPending] = React.useState(false)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const busy = loading || pending

  const handleClick = onClick
    ? (event: React.MouseEvent<HTMLButtonElement>) => {
      const result: unknown = onClick(event)
      if (typeof result === "object" && result !== null && typeof (result as PromiseLike<unknown>).then === "function") {
        setPending(true)
        void Promise.resolve(result as PromiseLike<unknown>)
          .then(() => undefined, () => undefined)
          .then(() => { if (mounted.current) setPending(false) })
      }
    }
    : undefined

  if (asChild) {
    return (
      <Slot.Root
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        onClick={handleClick}
        {...(disabled === undefined ? {} : { disabled })}
        {...props}
      >
        {children}
      </Slot.Root>
    )
  }

  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={busy || undefined}
      aria-busy={busy || undefined}
      className={cn(buttonVariants({ variant, size, className }), busy && "[&>svg:not(.button-spinner)]:hidden")}
      disabled={disabled || busy}
      onClick={handleClick}
      {...props}
    >
      {busy ? <LoaderCircle aria-hidden="true" className="button-spinner animate-spin" /> : null}
      {children}
    </button>
  )
}

export { Button, buttonVariants }
