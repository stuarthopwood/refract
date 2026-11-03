import * as React from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// `type="number"` also accepts these, which no whole-number setting wants.
const BLOCKED_KEYS: Record<string, true> = { e: true, E: true, "+": true, "-": true }

/** A native number input: visible spinners and ArrowUp/ArrowDown stepping from `min`, `step` and `max`.
 * Blocks exponent and sign keys, and blurs on wheel so scrolling a page never edits a focused value. */
function NumberField({ className, onKeyDown, onWheel, ...props }: Omit<React.ComponentProps<typeof Input>, "type">) {
  return (
    <Input
      type="number"
      data-slot="number-field"
      className={cn("[&::-webkit-inner-spin-button]:opacity-100", className)}
      onKeyDown={(event) => {
        if (BLOCKED_KEYS[event.key]) event.preventDefault()
        onKeyDown?.(event)
      }}
      onWheel={(event) => {
        event.currentTarget.blur()
        onWheel?.(event)
      }}
      {...props}
    />
  )
}

export { NumberField }
