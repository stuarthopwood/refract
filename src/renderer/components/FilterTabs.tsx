// The shared Filter tabs strip (#499, #504, ADR 0003): one non-wrapping, horizontally scrollable
// row of ghost tabs. The active tab gets a background plus the shared underline shape cue (a
// background shift alone is under the WCAG 1.4.11 3:1 floor). Behaviour carried over unchanged
// from the Pull requests list: the active tab scrolls into view (leaving `TABS_FADE_PX` of slack
// so it never lands behind its own fade), `data-fade-left`/`data-fade-right` are toggled from real
// scroll measurements (the `.pr-tabs-fade` CSS in `globals.css` must use the same pixel value), a
// vertical wheel maps onto horizontal scroll while the row can still scroll that way, and tab
// focus rings draw inward because the wrap clips overflow.
import { useLayoutEffect, useRef } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TAB_ACTIVE_UNDERLINE_CLASS } from '@/components/ui/tab-classes'
import { cn } from '@/lib/utils'

const TABS_FADE_PX = 24

const FILTER_TAB_TRIGGER_CLASS = cn(
  'flex-none rounded-md px-2 py-1 text-muted-foreground shadow-none hover:bg-muted/50 hover:text-foreground focus-visible:outline-offset-[-2px] focus-visible:ring-inset',
  TAB_ACTIVE_UNDERLINE_CLASS
)

export interface FilterTabsProps<T extends string> {
  value: T
  onValueChange(value: T): void
  tabs: ReadonlyArray<{ value: T; label: string }>
  /** Re-reveals the active tab when this changes (for example the scoped Project id). */
  revealKey?: string
}

export function FilterTabs<T extends string>({ value, onValueChange, tabs, revealKey }: FilterTabsProps<T>) {
  const tabsWrapRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const wrap = tabsWrapRef.current
    if (!wrap) return
    const updateFade = () => {
      wrap.toggleAttribute('data-fade-left', wrap.scrollLeft > 0)
      wrap.toggleAttribute('data-fade-right', wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1)
    }
    const revealActiveTab = () => {
      const tab = wrap.querySelector<HTMLElement>('[data-state="active"]')
      if (!tab) return
      const tabLeft = tab.offsetLeft
      const tabRight = tab.offsetLeft + tab.offsetWidth
      if (tabLeft < wrap.scrollLeft + TABS_FADE_PX) wrap.scrollLeft = Math.max(0, tabLeft - TABS_FADE_PX)
      else if (tabRight > wrap.scrollLeft + wrap.clientWidth - TABS_FADE_PX) wrap.scrollLeft = tabRight - wrap.clientWidth + TABS_FADE_PX
    }
    revealActiveTab()
    updateFade()
    wrap.addEventListener('scroll', updateFade, { passive: true })
    const observer = new ResizeObserver(() => {
      revealActiveTab()
      updateFade()
    })
    observer.observe(wrap)
    // `passive: false` only because this conditionally calls `preventDefault`; an already-at-the-
    // end wheel still scrolls the page normally (1px tolerance matches the fade check).
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      const canScrollMore = e.deltaY > 0 ? wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1 : wrap.scrollLeft > 0
      if (!canScrollMore) return
      e.preventDefault()
      wrap.scrollLeft += e.deltaY
    }
    wrap.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      wrap.removeEventListener('scroll', updateFade)
      wrap.removeEventListener('wheel', handleWheel)
      observer.disconnect()
    }
  }, [value, revealKey])

  return (
    <Tabs className="min-w-0 flex-1" value={value} onValueChange={(next) => onValueChange(next as T)} activationMode="manual">
      {/* `relative` is load-bearing: without a positioned wrap, `tab.offsetLeft` is measured
          against a distant offsetParent and the scroll target overshoots. `scroll-px-6` keeps a
          natively focused tab clear of the fade. */}
      <div
        ref={tabsWrapRef}
        className="relative min-w-0 scroll-px-6 overflow-x-auto pr-tabs-fade [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <TabsList className="h-8 w-max shrink-0 justify-start gap-1 rounded-none bg-transparent p-0">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className={FILTER_TAB_TRIGGER_CLASS}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  )
}
