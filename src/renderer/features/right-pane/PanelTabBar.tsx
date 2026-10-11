// The pane header (spec 013 FR-007/FR-008/FR-011, issue://394): a single title row with a Close
// button for exactly one open panel, or an ARIA tabs pattern bar for two or more. Either way it
// reserves the window-controls corner so no pane control ever sits under the native minimise/
// maximise/close buttons (FR-011) -- the same trailing spacer `ChatHeader.tsx` uses while it owns
// that corner instead.
//
// The tab bar is hand-rolled, not the shared `Tabs` primitive (`components/ui/tabs.tsx`): each
// tab needs its own close button, and issue://394's own prototype review flagged "close button
// inside the tablist" as a Medium accessibility finding. Each close button's own `tabIndex` is
// synced to the roving-tabindex state (0 only when its tab is the active one, -1 otherwise) so it
// never joins the arrow-key cycle, and it is not itself `role=tab` -- the pattern the W3C ARIA
// working group tested and confirmed accessible across NVDA/JAWS/VoiceOver (w3c/aria#2322) once
// button nesting inside role=tablist was raised as a real-world need.
//
// Declined (gate remediation, Medium, unreachable this slice): fully moving each close button out
// of the tablist's own DOM subtree (so axe's static `aria-required-children` rule stops flagging
// it) needs per-tab width measurement (a ResizeObserver, since tab width varies with its name and
// count) to keep a detached close button visually aligned -- real engineering cost for code this
// slice cannot reach (`HOSTED_PANELS` has one entry; a second panel, and so a real tab bar, ships
// in PR2). Deferred to PR2, where it can be built and verified against a real screen reader
// instead of only against axe's static rule.
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
const FOCUS_VISIBLE = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

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
        <h2 id="right-pane-panel-title" className="min-w-0 truncate text-sm font-semibold">
          {descriptor.name}
        </h2>
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
        aria-controls={selected ? `panel-content-${id}` : undefined}
        tabIndex={selected ? 0 : -1}
        className={cn(
          'relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 pr-8 text-sm font-medium',
          FOCUS_VISIBLE,
          selected
            ? 'bg-muted text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
        )}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span>{descriptor.name}</span>
        {count && <span className={count.kind === 'running' ? 'text-state-working' : undefined}>{formatPanelCount(count)}</span>}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            tabIndex={selected ? 0 : -1}
            aria-label={`Close ${descriptor.name} panel`}
            className={cn('absolute right-1 inline-flex size-6 items-center justify-center rounded hover:bg-muted', FOCUS_VISIBLE)}
            onClick={onClose}
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{`Close ${descriptor.name} panel`}</TooltipContent>
      </Tooltip>
    </span>
  )
}
