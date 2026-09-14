// Adapted from shadcn/ui new-york-v4 (progress); see THIRD_PARTY_NOTICES.md.
"use client"

import * as React from "react"
import { cn } from "./utils.js"
import { Progress as ProgressPrimitive } from "radix-ui"

/**
 * A progress bar, with a defined meaning for "no value yet".
 *
 * Work in this console runs for minutes - an install, a restore, an upload -
 * and some of it cannot say how far along it is. Passing no `value` gives the
 * indeterminate sweep rather than an empty bar, which reads as stuck.
 */
function Progress({
  className,
  value,
  tone = "default",
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  tone?: "default" | "success" | "attention" | "destructive"
}) {
  const indeterminate = value === null || value === undefined
  const clamped = indeterminate ? 0 : Math.max(0, Math.min(100, value))
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-tone={tone}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
      {...(indeterminate ? {} : { value: clamped })}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full transition-[width,transform] duration-300 ease-out",
          tone === "success" && "bg-[var(--success)]",
          tone === "attention" && "bg-[var(--attention)]",
          tone === "destructive" && "bg-destructive",
          tone === "default" && "bg-primary",
          indeterminate && "w-2/5 animate-[progress-sweep_1.4s_ease-in-out_infinite]"
        )}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
