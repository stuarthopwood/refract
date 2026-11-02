import * as React from "react"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

// The one option/tab look (#1302): muted text, foreground on hover, and when selected foreground
// text plus a 2px accent bar, no fill. Forced-colors swaps the bar for a `Highlight` border, and
// the transparent resting border keeps tabs from shifting 1px. Keys off `aria-selected` alone
// (Tooltip's own `data-state` can clobber Tabs' on a shared node); PanelTabBar reuses it.
export const TAB_LOOK_CLASS =
  "relative border border-transparent text-muted-foreground hover:text-foreground aria-selected:text-foreground aria-selected:after:absolute aria-selected:after:inset-x-2 aria-selected:after:bottom-0 aria-selected:after:h-0.5 aria-selected:after:rounded-sm aria-selected:after:bg-accent-text forced-colors:aria-selected:border-[Highlight] forced-colors:aria-selected:after:hidden"

// Hand-written (not `pnpm dlx shadcn add tabs`, no network in this environment), matching
// shadcn's own tabs.tsx shape exactly: a thin `data-slot`-tagged wrapper per Root/List/Trigger/
// Content node, built on the project's shared `radix-ui` meta-package import (see scroll-area.tsx,
// alert-dialog.tsx for the same pattern) rather than a separate `@radix-ui/react-tabs` dependency.
// Used by PullRequestList.tsx's five filter tabs (T012/T013) and PullRequestDetail.tsx's
// Overview/Changes pair (T015).

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex h-8 w-fit items-center justify-start gap-1 text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex flex-none items-center justify-center gap-2 px-2 py-1 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-focus-glow focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
        TAB_LOOK_CLASS,
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
