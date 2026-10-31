import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { XIcon } from 'lucide-react'
import { PANEL_HEADER_HEIGHT_CLASS, PanelHeader } from '@/components/PanelHeader'
import { IconButton } from '@/components/IconButton'
import { TAB_ACTIVE_UNDERLINE_CLASS } from '@/components/ui/tab-classes'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEnterOnSwitch } from '@/components/useEnterOnSwitch'
import { cn } from '@/lib/utils'
import { useRightPaneStore } from '@/state'
import { DiffStatCounts } from '../sessions/sessionDisplay'
import { compactPanelCount, formatPanelCount, getPanelDescriptor, splitPanelCount, usePanelCount, type PanelId } from './panel-registry'
import { closeHostedPanel } from './hosted-panel-actions'

const COMPACT_HIDE = '@max-[17.5rem]:hidden'
const CLOSE_BUTTON_PX = 24
const CLOSE_BUTTON_INSET_PX = 4

interface PanelTabBarProps {
  sessionId: string | null
}

export function PanelTabBar({ sessionId }: PanelTabBarProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const activePanelId = useRightPaneStore((s) => s.activePanelId)
  const openPanel = useRightPaneStore((s) => s.openPanel)
  const tabRefs = useRef<Partial<Record<PanelId, HTMLButtonElement | null>>>({})
  const wrapperRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tabListRef = useEnterOnSwitch<HTMLDivElement>(activePanelId, 'tabs')

  const [closePositions, setClosePositions] = useState<Partial<Record<PanelId, { left: number; top: number }>>>({})

  const recomputeClosePositions = () => {
    const next: Partial<Record<PanelId, { left: number; top: number }>> = {}
    for (const id of openPanelIds) {
      const el = tabRefs.current[id]
      if (!el) continue
      next[id] = {
        left: el.offsetLeft + el.offsetWidth - CLOSE_BUTTON_PX - CLOSE_BUTTON_INSET_PX,
        top: el.offsetTop + (el.offsetHeight - CLOSE_BUTTON_PX) / 2
      }
    }
    setClosePositions(next)
  }

  useLayoutEffect(() => {
    recomputeClosePositions()
    const tablist = wrapRef.current?.querySelector('[role="tablist"]')
    if (!tablist) return
    const observer = new ResizeObserver(() => recomputeClosePositions())
    observer.observe(tablist)
    for (const id of openPanelIds) {
      const el = tabRefs.current[id]
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanelIds])

  useLayoutEffect(() => {
    if (!activePanelId) return
    if (!useRightPaneStore.getState().open) return
    const wrap = wrapRef.current
    const tab = tabRefs.current[activePanelId]
    if (!wrap || !tab) return
    const tabLeft = tab.offsetLeft
    const tabRight = tab.offsetLeft + tab.offsetWidth
    if (tabLeft < wrap.scrollLeft) wrap.scrollLeft = tabLeft
    else if (tabRight > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = tabRight - wrap.clientWidth
  }, [activePanelId, openPanelIds])

  if (openPanelIds.length === 1) {
    const id = openPanelIds[0]
    const descriptor = id ? getPanelDescriptor(id) : undefined
    if (!id || !descriptor) return null

    return (
      <div className="flex shrink-0 flex-col">
        <PanelHeader
          ref={wrapperRef}
          actions={
            <IconButton label={`Close ${descriptor.name} panel`} data-panel-close onClick={() => closeHostedPanel(id)}>
              <XIcon aria-hidden className="size-4" />
            </IconButton>
          }
        >
          <h2 id="right-pane-panel-title" className="min-w-0 truncate text-sm font-medium">
            {descriptor.name}
          </h2>
        </PanelHeader>
      </div>
    )
  }

  function focusTab(id: PanelId): void {
    tabRefs.current[id]?.focus()
  }

  function closeTab(id: PanelId): void {
    const remainingCount = openPanelIds.length - 1
    closeHostedPanel(id, { skipFocusFallback: true })
    if (remainingCount === 1) {
      requestAnimationFrame(() => {
        wrapperRef.current?.querySelector<HTMLElement>('[data-panel-close]')?.focus()
      })
      return
    }
    const nextId = useRightPaneStore.getState().activePanelId
    if (nextId) requestAnimationFrame(() => focusTab(nextId))
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: PanelId): void {
    const index = openPanelIds.indexOf(id)
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const nextId = openPanelIds[(index + delta + openPanelIds.length) % openPanelIds.length]
      if (!nextId) return
      openPanel(nextId)
      focusTab(nextId)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const nextId = event.key === 'Home' ? openPanelIds[0] : openPanelIds[openPanelIds.length - 1]
      if (!nextId) return
      openPanel(nextId)
      focusTab(nextId)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      closeTab(id)
    }
  }

  return (
    <div className="flex shrink-0 flex-col">
      <div ref={wrapperRef} className={cn('no-drag-region flex shrink-0 items-center gap-1 px-2', PANEL_HEADER_HEIGHT_CLASS)}>
        <div ref={wrapRef} className="@container relative flex min-w-0 flex-1 items-center overflow-x-auto">
          <div ref={tabListRef} role="tablist" aria-label="Open panels" className="flex min-w-0 items-center gap-1">
            {openPanelIds.map((id) => (
              <TabButton
                key={id}
                id={id}
                selected={id === activePanelId}
                sessionId={sessionId}
                tabRef={(el) => {
                  tabRefs.current[id] = el
                }}
                onSelect={() => openPanel(id)}
                onKeyDown={(event) => handleTabKeyDown(event, id)}
              />
            ))}
          </div>
          {openPanelIds.map((id) => {
            const position = closePositions[id]
            const descriptor = getPanelDescriptor(id)
            if (!position || !descriptor) return null
            return (
              <IconButton
                key={id}
                label={`Close ${descriptor.name} panel`}
                shortcut={['Delete']}
                aria-keyshortcuts="Delete"
                tabIndex={id === activePanelId ? 0 : -1}
                data-panel-close
                className={cn(
                  INSET_FOCUS_OUTLINE_CLASS,
                  // The dark: hover class overrides the ghost variant's dark:hover:bg-row-hover-bg.
                  'transition-none focus-visible:border-transparent focus-visible:ring-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground',
                  id === activePanelId && 'text-foreground hover:bg-tab-close-hover-bg! dark:hover:bg-tab-close-hover-bg!'
                )}
                style={{ position: 'absolute', left: position.left, top: position.top }}
                onClick={() => closeTab(id)}
                onKeyDown={(event) => {
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    closeTab(id)
                  }
                }}
              >
                <XIcon aria-hidden className="size-4" />
              </IconButton>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface TabButtonProps {
  id: PanelId
  selected: boolean
  sessionId: string | null
  tabRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function TabButton({ id, selected, sessionId, tabRef, onSelect, onKeyDown }: TabButtonProps) {
  const descriptor = getPanelDescriptor(id)
  const count = usePanelCount(id, sessionId)
  if (!descriptor) return null
  const Icon = descriptor.icon
  const countText = count ? formatPanelCount(count) : undefined
  const fullLabel = `${descriptor.name}${countText ? ` ${countText}` : ''}`
  // The compact Git tab leads with the changed-files figure in its accessible name (WCAG 2.5.3).
  const accessibleLabel =
    count?.kind === 'additions-deletions'
      ? `${descriptor.name}, ${count.files} ${count.files === 1 ? 'file' : 'files'}, ${count.additions} ${count.additions === 1 ? 'addition' : 'additions'}, ${count.deletions} ${count.deletions === 1 ? 'deletion' : 'deletions'}`
      : fullLabel
  const parts = splitPanelCount(count)
  const countNumber = parts?.number
  const countWord = parts?.word
  const runningCls = count?.kind === 'running' ? 'text-state-working' : undefined
  const compactCount = compactPanelCount(count)
  const button = (
    <button
      ref={tabRef}
      role="tab"
      id={`panel-tab-${id}`}
      aria-selected={selected}
      aria-controls={selected ? `panel-content-${id}` : undefined}
      tabIndex={selected ? 0 : -1}
      className={cn(
        'inline-flex h-6 min-w-15 shrink items-center gap-1 rounded-md px-2 pr-8 text-sm',
        INSET_FOCUS_OUTLINE_CLASS,
        selected
          ? cn('font-semibold', TAB_ACTIVE_UNDERLINE_CLASS)
          : 'font-medium text-muted-foreground hover:bg-row-hover-bg hover:text-foreground'
      )}
      aria-label={countText ? accessibleLabel : undefined}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 shrink-[100] truncate">{descriptor.name}</span>
      {count?.kind === 'additions-deletions' ? (
        <span className={cn('shrink-0 text-xs', COMPACT_HIDE)}>
          <DiffStatCounts added={count.additions} removed={count.deletions} accessibleLabel />
        </span>
      ) : (
        countText && <span className={cn('shrink-0 tabular-nums', COMPACT_HIDE, runningCls)}>{countNumber}</span>
      )}
      {countWord && <span className={cn('min-w-0 shrink-[1000] truncate', COMPACT_HIDE, runningCls)}>{countWord}</span>}
      {compactCount && (
        <span aria-hidden className={cn('hidden shrink-0 text-xs tabular-nums @max-[17.5rem]:inline', runningCls)}>
          {compactCount}
        </span>
      )}
    </button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        {button}
      </TooltipTrigger>
      <TooltipContent>{fullLabel}</TooltipContent>
    </Tooltip>
  )
}
