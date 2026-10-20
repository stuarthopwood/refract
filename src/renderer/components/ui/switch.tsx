"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

// High remediation (a11y): the Off-state track was ~1.5:1 against the page (bg-input, 15%
// white over the dark background) and the focus ring ~1.9:1 at best (ring-ring/50, 50% opacity,
// with no solid focus-visible:border-ring the way Button/Badge both already have) -- both well
// under WCAG 1.4.11's 3:1 non-text-contrast minimum for a component/focus indicator.
// `dark:data-[state=unchecked]:bg-foreground/40` (computed via the OKLab->linear-sRGB->WCAG
// relative-luminance pipeline docs/DESIGN.md's "Chat text colour" note already uses) raises the
// Off track's own contrast well past 3:1 -- an EARLIER attempt here used `bg-input/80`, which
// Tailwind composites as 80% of `--input`'s own *already* mostly-transparent 15%-alpha value
// (0.15 * 0.8 = 0.12 effective alpha), actually *lowering* contrast to ~1.33:1; caught live via
// a real `getComputedStyle` read, not just visual inspection. Gate-fix (#1074 round 1, Code/Test
// Medium): `--foreground` itself became translucent (90% alpha) when #1074 softened app-wide
// text, so this `/40` modifier now MULTIPLIES with that alpha too (0.9 * 0.4 = 0.36 effective,
// not a flat 40%) -- `scripts/theme-contrast-pairs.mjs`'s own `switchTrackContrastRows` checks
// the real composited result against both surfaces a Switch renders on (`--background`,
// `--popover`), still comfortably clearing 3:1 in every theme (Obsidian/Nordic Frost's own
// popover, 3.21:1/3.22:1, is the binding case; `.theme-dark-high-contrast`'s own `--foreground`
// stays solid, unaffected). The solid
// `dark:data-[state=unchecked]:bg-foreground` thumb reaches ~5.2:1 against that now-lighter
// track (and ~19:1 against the page). `focus-visible:border-ring` matches the solid full-opacity
// ring Button/Badge both already use alongside their own low-opacity glow.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-foreground/40",
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
