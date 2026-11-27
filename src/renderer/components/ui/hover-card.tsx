"use client"

import * as React from "react"
import { createClickSuppression, type ClickSuppression } from "./hoverCardSuppression"
import { cn } from "@/lib/utils"
import { HoverCard as HoverCardPrimitive } from "radix-ui"

const ClickSuppressionContext = React.createContext<ClickSuppression | null>(null)

type HoverCardRootProps = React.ComponentProps<typeof HoverCardPrimitive.Root>

function HoverCard({
  suppressAfterClick = false,
  ...props
}: HoverCardRootProps & {
  /** After a click on the trigger the card stays closed until the pointer leaves and returns; focus from that click never opens it, keyboard focus still does. */
  suppressAfterClick?: boolean
}) {
  if (suppressAfterClick) return <ClickSuppressedHoverCard {...props} />
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

// Owns the open state so a press can close the card and a held-back open request can be dropped.
function ClickSuppressedHoverCard({ open, defaultOpen, onOpenChange, ...props }: HoverCardRootProps) {
  const [innerOpen, setInnerOpen] = React.useState(defaultOpen ?? false)
  const requestRef = React.useRef<(next: boolean) => void>(() => {})
  const [suppression] = React.useState(() => createClickSuppression(() => requestRef.current(false)))
  React.useEffect(() => {
    requestRef.current = (next) => {
      if (next && suppression.blocksOpen()) return
      if (open === undefined) setInnerOpen(next)
      onOpenChange?.(next)
    }
  })
  return (
    <ClickSuppressionContext.Provider value={suppression}>
      <HoverCardPrimitive.Root
        data-slot="hover-card"
        {...props}
        open={open ?? innerOpen}
        onOpenChange={(next) => requestRef.current(next)}
      />
    </ClickSuppressionContext.Provider>
  )
}

function HoverCardTrigger(props: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  const suppression = React.useContext(ClickSuppressionContext)
  if (!suppression) return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  // Radix composes its own `onFocus` after the caller's and skips it when `preventDefault` ran.
  return (
    <HoverCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      {...props}
      onPointerDown={(event) => {
        props.onPointerDown?.(event)
        suppression.onPointerDown()
      }}
      onClick={(event) => {
        props.onClick?.(event)
        suppression.onClick()
      }}
      onPointerLeave={(event) => {
        props.onPointerLeave?.(event)
        suppression.onPointerLeave()
      }}
      onFocus={(event) => {
        props.onFocus?.(event)
        suppression.onFocus(event)
      }}
    />
  )
}

function HoverCardContent({
  className,
  align = "start",
  side = "right",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-80 origin-(--radix-hover-card-content-transform-origin) rounded-lg bg-popover p-4 text-sm text-popover-foreground shadow-md ring-1 ring-elevated-edge outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
