"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from "@/components/ui/radio-group"
import {
  MENU_ITEM_CLASS,
  MENU_ITEM_DESTRUCTIVE_CLASS,
  MENU_CONTENT_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
  MENU_SUB_TRIGGER_CLASS,
} from "@/components/ui/menu-item-classes"
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
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          MENU_CONTENT_CLASS,
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
      // `--color-destructive` cue so the bar never reads as "current" on top of its red tint.
      className={cn(MENU_ITEM_CLASS, MENU_ITEM_DESTRUCTIVE_CLASS, className)}
      {...props}
    />
  )
}

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
      className={cn("group/radio-item", MENU_ITEM_CLASS, className)}
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

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(MENU_ITEM_CLASS, className)}
      {...props}
    >
      <span aria-hidden className="flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
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
      className={cn(MENU_SUB_TRIGGER_CLASS, className)}
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
        "origin-(--radix-dropdown-menu-content-transform-origin)",
        MENU_SUB_CONTENT_CLASS,
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
      className={cn(MENU_LABEL_CLASS, className)}
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
      className={cn(MENU_SEPARATOR_CLASS, className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
