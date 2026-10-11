// The pane header (spec 013 FR-007/FR-008/FR-011, issue://394): a single title row with a Close
// button for exactly one open panel, or an ARIA tabs pattern bar for two or more. Either way it
// reserves the window-controls corner so no pane control ever sits under the native minimise/
// maximise/close buttons (FR-011) -- the same trailing spacer `ChatHeader.tsx` uses while it owns
// that corner instead.
//
// The tab bar is hand-rolled, not the shared `Tabs` primitive (`components/ui/tabs.tsx`): each
// tab needs its own close button, and issue://394's own prototype review flagged "close button
// inside the tablist" as a Medium accessibility finding. Per the tab, not role=tab itself, and
// given its own tabIndex synced to the roving-tabindex state (0 only when its tab is the active
// one, -1 otherwise) so it never joins the arrow-key cycle -- the pattern the W3C ARIA working
// group tested and confirmed accessible across NVDA/JAWS/VoiceOver (w3c/aria#2322) once button
// nesting inside role=tablist was raised as a real-world need.
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRightPaneStore } from '@/state'
import { formatPanelCount, getPanelDescriptor, usePanelCount, type PanelId } from './panel-registry'
import { closeHostedPanel } from './hosted-panel-actions'

const WINDOW_CONTROLS_SPACER_STYLE = { width: 'calc(100vw - env(titlebar-area-width, 100vw))' }

interface PanelTabBarProps {
  /** The focused chat pane's Session -- feeds a per-Session panel's live count (data-model.md
   * `getPanelCount`), independent of which Session that panel's own content is bound to. */
  sessionId: string | null
}

export function PanelTabBar({ sessionId }: PanelTabBarProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const activePanelId = useRightPaneStore((s) => s.activePanelId)
  const openPanel = useRightPaneStore((s) => s.openPanel)
  const tabRefs = useRef<Partial<Record<PanelId, HTMLButtonElement | null>>>({})

  if (openPanelIds.length === 1) {
    const id = openPanelIds[0]
    const descriptor = id ? getPanelDescriptor(id) : undefined
    if (!id || !descriptor) return null
    return (
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 truncate text-sm font-semibold">{descriptor.name}</span>
        <div className="no-drag-region ml-auto flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Close ${descriptor.name} panel`}
                onClick={() => closeHostedPanel(id)}
              >
                <XIcon aria-hidden className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`Close ${descriptor.name} panel`}</TooltipContent>
          </Tooltip>
          <div aria-hidden className="shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
        </div>
      </div>
    )
  }

  function focusTab(id: PanelId): void {
    tabRefs.current[id]?.focus()
  }

  function closeTab(id: PanelId): void {
    const index = openPanelIds.indexOf(id)
    const remaining = openPanelIds.filter((openId) => openId !== id)
    closeHostedPanel(id)
    const nextId = remaining[Math.min(index, remaining.length - 1)]
    if (nextId) requestAnimationFrame(() => focusTab(nextId))
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: PanelId): void {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const index = openPanelIds.indexOf(id)
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const nextId = openPanelIds[(index + delta + openPanelIds.length) % openPanelIds.length]
      if (!nextId) return
      openPanel(nextId)
      focusTab(nextId)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      closeTab(id)
    }
  }

  return (
    <div className="drag-region flex h-10 shrink-0 items-center gap-1 px-2">
      <div role="tablist" aria-label="Open panels" className="no-drag-region flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {openPanelIds.map((id) => (
          <Tab
            key={id}
            id={id}
            selected={id === activePanelId}
            sessionId={sessionId}
            tabRef={(el) => {
              tabRefs.current[id] = el
            }}
            onSelect={() => openPanel(id)}
            onClose={() => closeTab(id)}
            onKeyDown={(event) => handleTabKeyDown(event, id)}
          />
        ))}
      </div>
      <div aria-hidden className="no-drag-region shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
    </div>
  )
}

interface TabProps {
  id: PanelId
  selected: boolean
  sessionId: string | null
  tabRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  onClose: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function Tab({ id, selected, sessionId, tabRef, onSelect, onClose, onKeyDown }: TabProps) {
  const descriptor = getPanelDescriptor(id)
  const count = usePanelCount(id, sessionId)
  if (!descriptor) return null
  const Icon = descriptor.icon
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <button
        ref={tabRef}
        role="tab"
        id={`panel-tab-${id}`}
        aria-selected={selected}
        aria-controls={`panel-content-${id}`}
        tabIndex={selected ? 0 : -1}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 pr-7 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
        )}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span>{descriptor.name}</span>
        {count && <span className={count.kind === 'running' ? 'text-state-working' : undefined}>{formatPanelCount(count)}</span>}
      </button>
      <button
        type="button"
        tabIndex={selected ? 0 : -1}
        aria-label={`Close ${descriptor.name} panel`}
        className="absolute right-1 inline-flex size-5 items-center justify-center rounded hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClose}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  )
}
