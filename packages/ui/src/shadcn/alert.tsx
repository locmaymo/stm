// Adapted from shadcn/ui new-york-v4 (alert); see THIRD_PARTY_NOTICES.md.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils.js"

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "bg-card text-foreground",
        info: "border-transparent bg-primary/10 text-foreground [&>svg]:text-primary",
        success:
          "border-transparent bg-[var(--success-background)] text-foreground [&>svg]:text-[var(--success)]",
        attention:
          "border-transparent bg-[var(--attention-background)] text-foreground [&>svg]:text-[var(--attention)]",
        destructive:
          "border-transparent bg-destructive/10 text-foreground [&>svg]:text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      // An error has to reach a screen reader when it appears, not only when
      // someone happens to tab past it.
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 font-medium", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle }
