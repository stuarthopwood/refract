import * as React from "react"
import { cn } from "@/lib/utils"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

// Shared radio ring/dot classes (#1043, ADR 0003) as strings, since the Radix primitives mount indicators differently.
// `RADIO_DOT_CLASS` must land on the Radix Indicator itself, not a nested span: the indicator is
// blockified as a grid item but a grandchild span stays inline, so `size-2` collapses to 0x0.
// The checked ring is `border-foreground`: `--primary` fell under 3:1 against `--popover` in Obsidian and Nordic Frost (WCAG 1.4.11).
/** Ring class for radio-style controls. */
export const RADIO_RING_CLASS = "grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground group-data-[state=checked]/radio-item:border-foreground"
/** Dot class drawn inside the ring when checked. */
export const RADIO_DOT_CLASS = "size-2 rounded-full bg-foreground forced-colors:bg-[CanvasText]"

/** Ring-and-dot for a non-Radix `role="option"` row (#1065); keys off its own `data-state`. */
export function RadioMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground data-[state=checked]:border-foreground forced-colors:data-[state=checked]:border-[Highlight]",
        className
      )}
    >
      {checked && <span className={RADIO_DOT_CLASS} />}
    </span>
  )
}

// Replaces MergeDialog's hand-rolled radiogroup; Root gives roving focus and wrap-around. ThemePicker
// keeps its own (its Home/End live-preview the theme, which this primitive doesn't do).
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        // forced-colors resets `border-primary`/`bg-primary/5`, so the checked border uses `Highlight`.
        // `outline-none focus-visible:outline-hidden` keeps the forced-colors outline off unfocused items.
        "group/radio-item flex w-full min-w-0 flex-col items-start gap-1 rounded-lg border border-border bg-background px-4 py-2 text-left text-sm outline-none focus-visible:outline-hidden transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 forced-colors:data-[state=checked]:border-[Highlight]",
        className
      )}
      {...props}
    />
  )
}

// Radix mounts this only while its item is checked.
function RadioGroupIndicator({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Indicator>) {
  return (
    <RadioGroupPrimitive.Indicator
      data-slot="radio-group-indicator"
      // Dot uses `--foreground` (`--primary` is too low-contrast on hover in Obsidian); forced-colors needs `CanvasText`.
      className={cn(RADIO_DOT_CLASS, className)}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupIndicator }
