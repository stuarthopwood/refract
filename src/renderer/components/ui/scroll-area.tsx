import * as React from "react"
import { cn } from "@/lib/utils"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

type ScrollAreaViewportProps = Pick<
  React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>,
  "tabIndex" | "aria-label" | "role"
>

function ScrollArea({
  className,
  children,
  viewportProps,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** Makes the scrolling viewport itself focusable and named, so its inset focus ring shows on every edge. */
  viewportProps?: ScrollAreaViewportProps
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      {/* Radix wraps `children` in a `display: table` div, so long rows never wrap and the panel
          grows sideways; the override lives here once for every consumer. The focus ring is
          `ring-inset` so a parent's `overflow-hidden` can't clip it. */}
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        {...viewportProps}
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring [&>div]:block! [&>div]:min-w-0!"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none transition-colors select-none data-horizontal:h-(--scrollbar-size) data-horizontal:flex-col data-vertical:h-full data-vertical:w-(--scrollbar-size)",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-[var(--scrollbar-thumb)] hover:bg-[var(--scrollbar-thumb-hover)]"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
