import * as React from "react"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

/** `asChild` styles and feeds props to the one child element instead of rendering an `<input>` (a cmdk input, say). */
function Input({ className, type, asChild, ...props }: React.ComponentProps<"input"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "input"
  return (
    <Comp
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-field-border bg-transparent px-2 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-(length:--field-ring-width) focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-field-hover-bg disabled:opacity-50 aria-invalid:not-focus-visible:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:not-focus-visible:ring-1 aria-invalid:not-focus-visible:ring-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
