import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-field-border bg-transparent px-2 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-(length:--field-ring-width) focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-field-hover-bg disabled:opacity-50 aria-invalid:not-focus-visible:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:not-focus-visible:ring-1 aria-invalid:not-focus-visible:ring-destructive md:text-sm dark:disabled:bg-input/80",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
