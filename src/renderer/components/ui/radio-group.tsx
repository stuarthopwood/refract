import * as React from "react"
import { cn } from "cn"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

// Hand-written (not `pnpm dlx shadcn add radio-group`, no network in this environment), matching
// shadcn's own radio-group.tsx shape: a thin `data-slot`-tagged wrapper per Root/Item/Indicator
// node, built on the project's shared `radix-ui` meta-package import (see tabs.tsx, scroll-area.tsx,
// alert-dialog.tsx for the same pattern).
// Quality-gate remediation (code-reviewer, Medium, issue #498): `MergeDialog.tsx` used to
// hand-roll a `role="radiogroup"`/`role="radio"` implementation (refs, key-to-index arithmetic,
// `tabIndex`/`aria-checked` wiring) that had already drifted from `ThemePicker.tsx`'s own,
// near-identical hand-rolled copy (one wrapped at the ends, the other didn't). Root already
// provides roving focus, arrow-key navigation and wrap-around, and `Item`/`Indicator` give the
// correct ARIA roles and `data-state` for free, so this replaces MergeDialog's copy.
// `ThemePicker.tsx` is NOT migrated here (cycle-2 quality-gate, Medium): its Home/End keys also
// live-preview the theme immediately, matching its arrow-key behaviour; this primitive's Home/End
// only move focus (Space selects), which would be a user-visible behaviour change outside this
// story's #498/#500 scope. Left as a follow-up (file alongside #498 if picked up).
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("flex flex-col gap-1.5", className)}
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
        // Quality-gate remediation (accessibility-auditor, Medium, forced-colors/Windows High
        // Contrast): `border-primary`/`bg-primary/5` both reset to system colours under
        // `forced-colors: active`, so the checked item looked identical to every other one;
        // `forced-colors:data-[state=checked]:border-[Highlight]` keeps a visible, theme-correct
        // border for the checked item specifically (the `Indicator` dot below carries the rest).
        // Quality-gate remediation (gate2, Low, forced-colors focus visibility): `outline-none`
        // sets `outline-style: none`, which `forced-colors` honours -- together with the box-shadow
        // focus ring and `border-ring` also being reset, a focused-but-unchecked item showed no
        // focus indicator at all in Windows High Contrast. `outline-hidden` keeps a transparent
        // outline instead of `none`, which `forced-colors` renders visibly.
        "group/radio-item flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm outline-hidden transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 forced-colors:data-[state=checked]:border-[Highlight]",
        className
      )}
      {...props}
    />
  )
}

// Renders only while its `RadioGroupItem` is checked (Radix handles the conditional mount), so a
// consumer never needs its own `candidate === value` check to decide whether to show it -- see
// `RadioGroupIndicator`'s doc comment on `MergeDialog.tsx`'s usage for the full visual.
function RadioGroupIndicator({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Indicator>) {
  return (
    <RadioGroupPrimitive.Indicator
      data-slot="radio-group-indicator"
      // Quality-gate remediation (accessibility-auditor, Medium, forced-colors): `bg-primary`
      // resets to a system colour under `forced-colors: active`, which (combined with the
      // Item's own reset border/tint above) made checked and unchecked items indistinguishable
      // in Windows High Contrast. `forced-colors:bg-[CanvasText]` keeps the dot visible using the
      // standard forced-colors system keyword for foreground/text colour.
      className={cn("size-2 rounded-full bg-primary forced-colors:bg-[CanvasText]", className)}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupIndicator }
