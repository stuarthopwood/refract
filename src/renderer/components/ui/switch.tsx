"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

// `dark:data-[state=unchecked]:bg-switch-off-dark-bg` (computed via the OKLab->linear-sRGB->WCAG
// relative-luminance pipeline docs/DESIGN.md's "Chat text colour" note already uses) raises the Off
// track's own contrast well past 3:1 -- an EARLIER attempt here used `bg-input/80`, which Tailwind
// composites as 80% of `--input`'s own *already* mostly-transparent 15%-alpha value (0.15 0.8 =
// 0.12 effective alpha), actually *lowering* contrast to ~1.33:1; caught live via a real
// `getComputedStyle` read, not just visual inspection.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-focus-glow disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-switch-off-dark-bg",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 dark:data-[state=unchecked]:bg-foreground"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
