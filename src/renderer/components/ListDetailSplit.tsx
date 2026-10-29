// The shared list and detail split (#930, #504): a resizable list column beside a detail pane, used
// by the Pull requests and Issues views so both keep one width, one clamp and one reset rule.
// The list column width is a single remembered value (`pull-requests-layout-store.ts`) for every
// view that uses this split.
//
// Behaviour carried over unchanged from the Pull requests view (issue #930 gate fixes):
// - `defaultSize` stays pinned at the true default: it is also `react-resizable-panels`'
//   double-click-reset target, so binding it to the live width would make reset a no-op. A
//   remembered non-default width is applied once, imperatively, on mount; it is read in the first
//   render because a child's layout effect reports the default width before this effect runs.
// - `maxSize` is a live percentage of the group's measured width, floored so it can never resolve
//   below the minimum: a static "50%" conflicts with a pixel minimum when the group is under twice
//   the minimum, and `maxSize` wins that conflict.
// - `onResize` is the one source of truth for the width, and `setWidth` persists it (debounced).
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import {
  PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX,
  PULL_REQUESTS_LIST_MIN_WIDTH_PX,
  usePullRequestsLayoutStore
} from '@/state'

export interface ListDetailSplitProps {
  /** Prefix for the two panel ids, for example `pull-requests`. */
  idPrefix: string
  resizeLabel: string
  list: ReactNode
  detail: ReactNode
  /** Optional element refs for a caller that measures the panel (the Pull requests header). */
  panelElementRef?: RefObject<HTMLDivElement | null>
  groupElementRef?: RefObject<HTMLDivElement | null>
}

export function ListDetailSplit({ idPrefix, resizeLabel, list, detail, panelElementRef, groupElementRef }: ListDetailSplitProps) {
  const initialWidthPxRef = useRef(usePullRequestsLayoutStore.getState().widthPx)
  const panelRef = useRef<PanelImperativeHandle>(null)
  const ownGroupRef = useRef<HTMLDivElement | null>(null)
  const groupRef = groupElementRef ?? ownGroupRef
  const [maxSizePercent, setMaxSizePercent] = useState(50)

  useLayoutEffect(() => {
    const persistedWidthPx = initialWidthPxRef.current
    if (persistedWidthPx !== PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX) panelRef.current?.resize(persistedWidthPx)
  }, [])

  useLayoutEffect(() => {
    const groupEl = groupRef.current
    if (!groupEl) return
    const measure = () => {
      const groupWidth = groupEl.getBoundingClientRect().width
      if (groupWidth > 0) {
        setMaxSizePercent(Math.max(50, (PULL_REQUESTS_LIST_MIN_WIDTH_PX / groupWidth) * 100))
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(groupEl)
    return () => observer.disconnect()
  }, [groupRef])

  return (
    <ResizablePanelGroup elementRef={groupRef} orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel
        id={`${idPrefix}-list`}
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize={PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX}
        minSize={PULL_REQUESTS_LIST_MIN_WIDTH_PX}
        maxSize={`${maxSizePercent}%`}
        className="overflow-hidden"
        onResize={(size) => usePullRequestsLayoutStore.getState().setWidth(size.inPixels)}
      >
        {list}
      </ResizablePanel>
      <ResizableHandle withHandle aria-label={resizeLabel} />
      <ResizablePanel id={`${idPrefix}-detail`}>
        <div className="h-full min-w-0 overflow-hidden">{detail}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
