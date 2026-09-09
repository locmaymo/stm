// Adapted from shadcn/ui new-york-v4 (skeleton); see THIRD_PARTY_NOTICES.md.
import { cn } from "./utils.js"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
