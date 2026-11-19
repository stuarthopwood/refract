import { useCallback, useEffect, useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { useRightPaneStore } from '@/state/right-pane-store'
import { scrollLeftToReveal } from './tab-strip-scroll'

interface RevealActiveTabArgs {
  activeKey: string | null
  itemCount: number
  tabRefs: RefObject<Record<string, HTMLButtonElement | null>>
  /** The strip's own scrollers (pinned panel group, document tabs); either may be absent. */
  scrollerRefs: readonly RefObject<HTMLElement | null>[]
}

/** Keeps the active tab in view inside whichever strip scroller holds it, on activation and when the strip is resized. */
export function useRevealActiveTab({ activeKey, itemCount, tabRefs, scrollerRefs }: RevealActiveTabArgs): void {
  const reveal = useCallback(() => {
    if (!activeKey || !useRightPaneStore.getState().open) return
    // The tab and its close button; only a strip scroller moves, never the overflow-hidden shell.
    const span = tabRefs.current[activeKey]?.parentElement
    const scroller = span ? scrollerRefs.map((ref) => ref.current).find((el) => el?.contains(span)) : undefined
    if (!span || !scroller) return
    const next = scrollLeftToReveal({ scrollLeft: scroller.scrollLeft, viewWidth: scroller.clientWidth }, { start: span.offsetLeft, width: span.offsetWidth })
    if (next !== scroller.scrollLeft) scroller.scrollLeft = next
  }, [activeKey, tabRefs, scrollerRefs])

  useLayoutEffect(reveal, [reveal, itemCount])

  useEffect(() => {
    const observer = new ResizeObserver(reveal)
    for (const ref of scrollerRefs) if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [reveal, scrollerRefs, itemCount])
}
