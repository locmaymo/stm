// Built on the Radix Toast primitive; styled to match shadcn/ui new-york-v4.
"use client"

import * as React from "react"
import { cn } from "./utils.js"
import { CheckCircle2, CircleAlert, Info, TriangleAlert, XIcon } from "lucide-react"
import { Toast as ToastPrimitive } from "radix-ui"

/**
 * Short-lived confirmation, out of the way.
 *
 * Every action in this console used to report itself by leaving a sentence
 * behind on the page - "Saved", "Uploaded", "Could not reach the bucket" - so
 * the page slowly filled with the history of what had been pressed. A result
 * that the operator only needs to see once belongs here and then gone. What
 * they need to keep seeing is state, and state belongs in the card that owns
 * it, not in a toast.
 */

export type ToastTone = "default" | "success" | "attention" | "destructive"

export interface ToastOptions {
  readonly title: string
  readonly description?: string
  readonly tone?: ToastTone
  /** Milliseconds on screen. An error stays until dismissed unless overridden. */
  readonly duration?: number
  readonly action?: { readonly label: string; readonly onSelect: () => void }
}

interface ToastRecord extends ToastOptions {
  readonly id: number
}

interface ToastApi {
  readonly toast: (options: ToastOptions) => number
  readonly dismiss: (id: number) => void
}

const ToastContext = React.createContext<ToastApi | null>(null)

/**
 * The toast API.
 *
 * Outside a provider this is a no-op rather than a thrown error: a component
 * rendered in isolation, or in a test, should not crash because nothing is
 * listening for its confirmations.
 */
export function useToast(): ToastApi {
  const api = React.useContext(ToastContext)
  return api ?? fallbackApi
}

const fallbackApi: ToastApi = { toast: () => -1, dismiss: () => undefined }

const DEFAULT_DURATION = 4500
const ERROR_DURATION = 10_000

const toneIcon: Record<ToastTone, React.ComponentType<{ className?: string }>> = {
  default: Info,
  success: CheckCircle2,
  attention: TriangleAlert,
  destructive: CircleAlert,
}

export function Toaster({ children }: { children?: React.ReactNode }) {
  const [items, setItems] = React.useState<readonly ToastRecord[]>([])
  const nextId = React.useRef(1)

  const dismiss = React.useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = React.useCallback((options: ToastOptions) => {
    const id = nextId.current
    nextId.current += 1
    // Five is already more than anyone reads; older ones go rather than
    // stacking into a column that covers the page it is reporting on.
    setItems((current) => [...current.slice(-4), { ...options, id }])
    return id
  }, [])

  const api = React.useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="right" duration={DEFAULT_DURATION}>
        {children}
        {items.map((item) => {
          const tone = item.tone ?? "default"
          const Icon = toneIcon[tone]
          const duration =
            item.duration ?? (tone === "destructive" ? ERROR_DURATION : DEFAULT_DURATION)
          return (
            <ToastPrimitive.Root
              key={item.id}
              data-slot="toast"
              data-tone={tone}
              duration={duration}
              onOpenChange={(open) => {
                if (!open) dismiss(item.id)
              }}
              className={cn(
                "group pointer-events-auto grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1 rounded-lg border bg-popover p-3.5 text-popover-foreground shadow-[var(--elevation-2)]",
                "data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2 sm:data-[state=open]:slide-in-from-right-4",
                "data-[swipe=end]:animate-out data-[swipe=end]:fade-out-80",
                tone === "success" && "border-[var(--success)]/35",
                tone === "attention" && "border-[var(--attention)]/40",
                tone === "destructive" && "border-destructive/40"
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  tone === "success" && "text-[var(--success)]",
                  tone === "attention" && "text-[var(--attention)]",
                  tone === "destructive" && "text-destructive",
                  tone === "default" && "text-primary"
                )}
              />
              <div className="grid min-w-0 gap-0.5">
                <ToastPrimitive.Title className="text-sm leading-snug font-medium">
                  {item.title}
                </ToastPrimitive.Title>
                {item.description ? (
                  <ToastPrimitive.Description className="text-xs leading-relaxed break-words text-muted-foreground">
                    {item.description}
                  </ToastPrimitive.Description>
                ) : null}
                {item.action ? (
                  <ToastPrimitive.Action
                    altText={item.action.label}
                    onClick={item.action.onSelect}
                    className="mt-1.5 justify-self-start rounded-md text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {item.action.label}
                  </ToastPrimitive.Action>
                ) : null}
              </div>
              <ToastPrimitive.Close
                aria-label="Close"
                className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-70 outline-none hover:bg-accent hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <XIcon className="size-3.5" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          )
        })}
        <ToastPrimitive.Viewport
          data-slot="toast-viewport"
          // Bottom on a phone, where the thumb is and where it does not cover
          // the header; bottom right from small up.
          className="pointer-events-none fixed inset-x-3 bottom-3 z-[100] m-0 flex max-h-screen w-auto list-none flex-col gap-2 p-0 outline-none sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22rem]"
        />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}
