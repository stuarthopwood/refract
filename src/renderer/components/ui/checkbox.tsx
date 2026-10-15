import * as React from "react"
import { CheckIcon } from "lucide-react"
import { cn } from "cn"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

// New for #572 (issue #572 decision D9): a copy of `radio-group.tsx` on Radix Checkbox, so the
// ask card's multiple-choice rows get a square tick that contrasts the single-choice round dot
// by SHAPE, not colour (decision D9's own reason). `globals.css:785`'s squared-corner rule
// already lists `[role='checkbox']` (added alongside this file), so no `rounded-*` override is
// needed here even though the row keeps `rounded-lg` for its own border, exactly like
// `radio-group.tsx`'s `RadioGroupItem`. Radix's `Checkbox` has no `RadioGroup.Root`-equivalent
// group wrapper (each checkbox is independently controlled), so unlike `radio-group.tsx` there is
// no `Checkbox` root export here; a consumer renders its own `role="group"` wrapper (as
// `radio-group.tsx`'s own `RadioGroup` effectively is for radios) and manages the full ticked-set
// itself.
function CheckboxItem({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox-item"
      className={cn(
        // Mirrors `radio-group.tsx`'s own `RadioGroupItem` className verbatim (D30: forced-colours
        // and focus-ring handling copied, not reinvented) -- see that file's own comments for why
        // each piece (the `outline-none focus-visible:outline-hidden` split, the
        // `forced-colors:data-[state=checked]:border-[Highlight]` fallback) exists.
        "group/checkbox-item flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm outline-none focus-visible:outline-hidden transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 forced-colors:data-[state=checked]:border-[Highlight]",
        className
      )}
      {...props}
    />
  )
}

// Renders only while its `CheckboxItem` is checked (Radix conditionally mounts `Indicator`),
// same as `radio-group.tsx`'s own `RadioGroupIndicator`. D10: the tick glyph uses `--foreground`,
// not `--primary` (Obsidian's `--primary` measures too low a contrast on the hover surface).
function CheckboxIndicator({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Indicator>) {
  return (
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      className={cn("flex items-center justify-center text-foreground forced-colors:text-[CanvasText]", className)}
      {...props}
    >
      <CheckIcon aria-hidden className="size-3" />
    </CheckboxPrimitive.Indicator>
  )
}

export { CheckboxItem, CheckboxIndicator }
