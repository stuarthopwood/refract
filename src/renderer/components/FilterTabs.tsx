import { useLayoutEffect, useRef } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const TABS_FADE_PX = 24

const FILTER_TAB_TRIGGER_CLASS = 'focus-visible:outline-offset-[-2px] focus-visible:ring-inset'

export interface FilterTabsProps<T extends string> {
  value: T
  onValueChange(value: T): void
  tabs: ReadonlyArray<{ value: T; label: string }>
  revealKey?: string
  ariaLabel?: string
}

export function FilterTabs<T extends string>({ value, onValueChange, tabs, revealKey, ariaLabel }: FilterTabsProps<T>) {
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
      <div
        ref={tabsWrapRef}
        className="relative min-w-0 scroll-px-6 overflow-x-auto pr-tabs-fade no-scrollbar"
      >
        <TabsList aria-label={ariaLabel} className="w-max shrink-0">
          {tabs.map((tab) => (
            // No TabsContent is rendered, so Radix's aria-controls would point at nothing.
            <TabsTrigger key={tab.value} value={tab.value} aria-controls={undefined} className={FILTER_TAB_TRIGGER_CLASS}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  )
}
