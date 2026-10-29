"use client"

import { cn } from "@/lib/utils"
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  noDragHit,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
  // #674: gives the 12px hit area back when it overlaps a `drag-region` (title bar rows).
  noDragHit?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "group/handle relative z-10 flex w-px items-center justify-center bg-divider ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-3 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div
          aria-hidden="true"
          data-slot="resizable-grip"
          className="pointer-events-none z-10 h-8 min-h-8 w-1 min-w-1 shrink-0 rounded-full bg-border transition-colors group-hover/handle:bg-muted-foreground group-focus-visible/handle:bg-accent-text group-focus-visible/handle:outline-2 group-focus-visible/handle:outline-offset-2 group-focus-visible/handle:outline-accent-text group-data-[separator=active]/handle:bg-accent-text group-data-[separator=disabled]/handle:opacity-0 forced-colors:bg-[CanvasText] forced-colors:group-hover/handle:bg-[Highlight] forced-colors:group-focus-visible/handle:bg-[Highlight] forced-colors:group-focus-visible/handle:outline-[Highlight] forced-colors:group-data-[separator=active]/handle:bg-[Highlight] motion-reduce:transition-none"
        />
      )}
      {noDragHit && (
        <div
          aria-hidden="true"
          className="no-drag-region pointer-events-none absolute inset-y-0 left-1/2 w-3 -translate-x-1/2"
        />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
