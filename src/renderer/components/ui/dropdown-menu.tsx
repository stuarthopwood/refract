"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { ChevronRightIcon } from "lucide-react"
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from "@/components/ui/radio-group"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
  )
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  )
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "end",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPortal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </DropdownMenuPortal>
  )
}

function DropdownMenuItem({
  className,
  variant = "default",
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: "default" | "destructive"
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      data-inset={inset}
      // Gate round 5 fix (Visual Medium #11): the active-row inset shadow used the plain focus-
      // ring token (`--color-ring`), a different cue from the composer's own pickers, which use
      // the opaque `--active-indicator` token for the SAME purpose (gate round 2) -- unified so
      // every menu's active-row cue is the same colour. Gate round 6 fix (`agent://Arch877`
      // Medium 2): a destructive item (Sign out, Remove repository...) keeps its OWN focus cue,
      // `--color-destructive` instead of the indigo `--active-indicator`, so the bar never reads
      // as "active/current" sitting on top of the red tint it already gets below.
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:shadow-[inset_2px_0_0_0_var(--color-active-indicator)] data-disabled:pointer-events-none data-disabled:opacity-50 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:focus:shadow-[inset_2px_0_0_0_var(--color-destructive)] data-[inset=true]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

/** Gate round 1 fix (code-reviewer HIGH, issue #564): the Reasoning picker's own current-level
 * selection used a plain `DropdownMenuItem` with a decorative, `aria-hidden` check icon, so a
 * screen reader never heard which level was current. Radix's own `RadioGroup`/`RadioItem`
 * expose that as `aria-checked`/`role="menuitemradio"` automatically. */
function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      // Issue #1043 (grilled 2026-10-19, ADR 0003): the TRAILING `CheckIcon` the Gate round 1
      // history above (`DropdownMenuRadioGroup`'s own comment) records read as an unselected
      // (the round swatches in the Theme submenu, its first caller, looked identical whether
      // checked or not). Moves to the SAME leading ring-and-dot mark the Ask card's radios use
      // (`RADIO_RING_CLASS`/`RADIO_DOT_CLASS`, `radio-group.tsx`'s own shared source, ADR 0003 --
      // never a second hand-rolled copy), so the checked row is visibly filled, not merely
      // inferred from a trailing glyph. `group/radio-item` plus Radix's own `data-state`
      // attribute (set on every `RadioItem` root, checked/unchecked) is what the ring's
      // `group-data-[state=checked]/radio-item:` selector keys off, the same mechanism
      // `RadioGroupItem` uses for the identical selector. Unlike Ask card/MergeDialog (full
      // bordered cards whose OWN border already carries a `forced-colors:data-[state=checked]:
      // border-[Highlight]` override), a menu row has no bordered-card fallback, so the ring
      // itself needs that override here, or a checked and an unchecked row would render
      // identically under Windows High Contrast (the same failure mode `RadioGroupItem`'s own
      // comment documents, just with no outer border to lean on this time). The inset shadow
      // stays on `--active-indicator`, same as `DropdownMenuItem` above -- unrelated to this
      // fix, that cue follows focus, never selection (2026-10-15 decision, unchanged).
      className={cn(
        "group/radio-item relative flex w-full cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:shadow-[inset_2px_0_0_0_var(--color-active-indicator)] data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(RADIO_RING_CLASS, "forced-colors:group-data-[state=checked]/radio-item:border-[Highlight]")}
      >
        {/* Gate finding (Main, live pixel sample, 2026-10-20): the dot never painted -- a bare
            `<span>` is `display: inline` by the UA stylesheet, and CSS explicitly says `width`/
            `height` do NOT apply to a non-replaced inline box (CSS2.1 10.3.1/10.6.1), so the
            dot's own `size-2` silently collapsed to a 0x0 box. `ItemIndicator` renders a BARE
            `Primitive.span` (`@radix-ui/react-menu`), which becomes a direct CSS Grid item of
            the ring above -- a grid item's `display` is "blockified" (CSS Display Level 3 2.7),
            but ONLY for the item itself, never for a child nested one level deeper inside it.
            The earlier code put `RADIO_DOT_CLASS` on an EXTRA nested `<span>` INSIDE
            `ItemIndicator`, which stayed plain `inline` and never got blockified, so its own
            `size-2` was ignored -- invisible despite being correctly mounted (every structural
            DOM check this file's own live-check script ran still passed). `RadioGroupIndicator`
            (`radio-group.tsx`) never hit this: `AskCard.tsx`/`MergeDialog.tsx` apply its class
            directly to the ring's own sole child (also a bare `Primitive.span`, same package
            family), which IS the blockified grid item. Fix: put `RADIO_DOT_CLASS` directly on
            `ItemIndicator` itself -- it becomes the direct, blockified grid item, same as
            `RadioGroupIndicator`, and `size-2` finally applies. */}
        <DropdownMenuPrimitive.ItemIndicator className={RADIO_DOT_CLASS} />
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:shadow-[inset_2px_0_0_0_var(--color-active-indicator)] data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[inset=true]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "z-50 min-w-32 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1 text-sm data-[inset=true]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
}
