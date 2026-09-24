// Adapted from shadcn/ui new-york-v4 (button-group); see THIRD_PARTY_NOTICES.md.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils.js"

const buttonGroupVariants = cva(
  "flex w-fit items-stretch [&>*]:focus-visible:relative [&>*]:focus-visible:z-10",
  {
    variants: {
      orientation: {
        horizontal:
          "[&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none",
        vertical:
          "flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none",
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  }
)

/**
 * Buttons joined into one control, like a primary action with its menu.
 *
 * Each button keeps its own height; the group only squares off the corners
 * where they meet, so a button and the arrow beside it are always the same
 * height whatever a page does to either.
 */
function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation ?? "horizontal"}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  )
}

/**
 * The line between two joined buttons.
 *
 * Drawn in the buttons' own colour, a shade off, rather than as a see-through
 * white: over a white card that left a pale gap which read as two buttons
 * standing apart. Dimmed with them when they are disabled.
 */
function ButtonGroupSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="button-group-separator"
      className={cn("w-px shrink-0 self-stretch bg-[color-mix(in_oklab,var(--primary)_70%,var(--primary-foreground))] [[data-slot=button-group]:has(>button:disabled)>&]:opacity-50", className)}
      {...props}
    />
  )
}

export { ButtonGroup, ButtonGroupSeparator, buttonGroupVariants }
