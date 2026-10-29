import * as React from "react"
import { cn } from "@/lib/utils"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

// Issue #1043 (ADR 0003): the ring-and-dot mark every radio-style control in the app draws.
// `RADIO_RING_CLASS` is shared by `dropdown-menu.tsx`'s and `context-menu.tsx`'s radio items,
// `AskCard.tsx` and `MergeDialog.tsx` (#1065); `RadioGroupIndicator` below draws the dot for the
// latter two.
// Exported as
// plain class-string constants (this codebase's established pattern for a cross-file shared
// look, e.g. `pickerShared.tsx`'s `PICKER_TRIGGER_CLASS`) rather than a JSX component: the two
// Radix primitives involved (`RadioGroupPrimitive.Indicator` here, `DropdownMenuPrimitive.
// ItemIndicator` there) mount conditionally in different, primitive-specific ways, so only the
// CSS belongs here, not a wrapper tied to one primitive.
// IMPORTANT for every consumer: `RADIO_DOT_CLASS` must land on the ring's own DIRECT child (the
// Radix Indicator primitive itself), never on an extra nested `<span>` one level deeper. Both
// `RadioGroupPrimitive.Indicator` and `DropdownMenuPrimitive.ItemIndicator` render a bare,
// unstyled `<span>` (`display: inline` by the UA stylesheet); a grid item's own display is
// "blockified" (CSS Display Level 3 2.7) so `size-2` applies when the class lands there directly
// -- but blockification does NOT cascade to a grandchild, so a `size-2` dot nested one level
// deeper silently collapses to 0x0 (width/height do not apply to non-replaced inline boxes,
// CSS2.1 10.3.1/10.6.1) and never paints, confirmed live (#1043, Main's pixel sample caught the
// Theme submenu's own first cut of this exact mistake, `dropdown-menu.tsx`'s own fix comment).
// Gate round 1 fix (PR #1057, Code/Test/UI High, 2026-10-20): the checked ring's own border was
// `border-primary`, matching the Ask card's own look -- but `--primary` measured only
// 2.92-2.99:1 against `--popover` in Obsidian/Nordic Frost/Cyber Amber at the time (under the
// 3:1 WCAG 1.4.11 floor), and was visibly INVERTED there (a checked row's own ring read
// FAINTER than an unchecked row's, since `--primary`'s own relative luminance was LOWER than
// `--muted-foreground`'s in those three themes -- confirmed by direct measurement, not
// assumed). `--primary` still cleared 3:1 against `--card`/`--background` everywhere (the Ask
// card's own dialog surfaces) -- `--popover` (the menu surface this ring is NEW to) was the one
// surface it failed, so this was never "the same pre-existing gap" the #572 decision D10
// comment below describes for a DIFFERENT token (`RadioGroupIndicator`'s own dot). Changed to
// `border-foreground`: `foreground`/`popover` is already a gated PAIRS entry (`scripts/theme-
// contrast-pairs.mjs`) and clears comfortably in every theme; `foreground`/`accent` (the row's
// own `focus:bg-accent` fill) is added alongside it for the focused-row case. #1039 (2026-10-20,
// later the same day) retuned Cyber Amber's own `--primary` to `#c2410c`, which now clears 3:1
// against its own `--popover` on its own (3.46:1) -- Obsidian (2.99:1) and Nordic Frost (2.92:1)
// still measure under the floor, so this fix stays unconditional (`border-foreground`
// everywhere), never reverted for Cyber Amber alone.
// `AskCard.tsx`/`MergeDialog.tsx` now use the same ring (#1065), so their checked ring is
// `border-foreground` too, no longer `border-primary`; the row's own `border-primary` edge stays.
export const RADIO_RING_CLASS = "grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground group-data-[state=checked]/radio-item:border-foreground"
export const RADIO_DOT_CLASS = "size-2 rounded-full bg-foreground forced-colors:bg-[CanvasText]"

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
        // Quality-gate remediation (accessibility-auditor, Medium, forced-colors/Windows High
        // Contrast): `border-primary`/`bg-primary/5` both reset to system colours under
        // `forced-colors: active`, so the checked item looked identical to every other one;
        // `forced-colors:data-[state=checked]:border-[Highlight]` keeps a visible, theme-correct
        // border for the checked item specifically (the `Indicator` dot below carries the rest).
        // Quality-gate remediation (gate3, Medium): a bare `outline-hidden` draws its
        // `forced-colors` transparent-outline rule unconditionally (it is not scoped to
        // `:focus-visible`), so EVERY item -- not just the focused one -- got a 2px system-colour
        // outline in Windows High Contrast, which is the same "focused item looks like every
        // other one" problem the gate2 fix was meant to solve, just drawn differently. `outline-none
        // focus-visible:outline-hidden` keeps the normal-mode behaviour identical (`outline-none`
        // alone already resolves to `outline-style: none`, same as `outline-hidden` would) while
        // only drawing the `forced-colors` transparent outline on the item that actually has
        // keyboard focus.
        "group/radio-item flex w-full min-w-0 flex-col items-start gap-1 rounded-lg border border-border bg-background px-4 py-2 text-left text-sm outline-none focus-visible:outline-hidden transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 forced-colors:data-[state=checked]:border-[Highlight]",
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
      // #572 decision D10: the dot uses `--foreground`, not `--primary` -- Obsidian's `--primary`
      // measures too low a contrast on the row's own hover surface; the row edge (`border-primary`
      // above) stays as reinforcement, only the glyph itself moved.
      className={cn(RADIO_DOT_CLASS, className)}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupIndicator }
