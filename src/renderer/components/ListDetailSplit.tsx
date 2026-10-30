// A resizable list column beside a detail pane, shared by the Pull requests and Issues views (#930, #504).
// `defaultSize` stays pinned at the true default because it is also the double-click-reset target; a
// remembered width is applied once on mount. `maxSize` is a live percentage floored above the pixel
// minimum, since a static "50%" loses to it in a narrow group.
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
