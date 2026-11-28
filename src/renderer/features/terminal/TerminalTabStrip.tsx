import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { PlusIcon, XIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { InlineStatus } from '@/components/InlineStatus'
import { TAB_LOOK_CLASS } from '@/components/ui/tabs'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { cn } from '@/lib/utils'
import { useTerminalStore } from '@/state/terminal-store'
import type { TabInfo } from '../../../shared/ipc-terminal'
import { MAX_TABS_PER_SESSION, NAME_MAX_CHARS } from '../../../shared/terminalLimits'
import { scrollLeftToReveal } from '../right-pane/tab-strip-scroll'
import { useCloseFlow } from './ClosePrompt'
import { renamedValue, tabIndexForKey, tabMarker, type TabMarker } from './terminalTabs'

// The Session's terminal tabs. Only this Session's tabs appear; switching one never stops another (spec 144 FR-003, FR-009).

const MARKER_DOT: Record<TabMarker['tone'], string> = {
  running: 'hidden',
  starting: 'bg-muted-foreground motion-safe:animate-pulse',
  ended: 'bg-muted-foreground',
  failed: 'bg-destructive'
}

interface TerminalTabStripProps {
  sessionId: string
  tabs: readonly TabInfo[]
  activeTabId: string | null
  /** A create is in flight; a second one would race the first. */
  adding: boolean
  onSelect(tabId: string): void
  onAdd(): void
  /** Returns the keyboard to the terminal after the close prompt. */
  restoreFocus(): void
}

export function TerminalTabStrip({ sessionId, tabs, activeTabId, adding, onSelect, onAdd, restoreFocus }: TerminalTabStripProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLElement>())
  const close = useCloseFlow(sessionId, restoreFocus)
  const atLimit = tabs.length >= MAX_TABS_PER_SESSION
  const addLabel = atLimit ? `New terminal (the maximum of ${MAX_TABS_PER_SESSION} tabs is open)` : 'New terminal'

  // A tab scrolled out of view by a long strip must come back when it becomes the active one.
  useEffect(() => {
    const scroller = scrollerRef.current
    const tab = activeTabId ? tabRefs.current.get(activeTabId) : undefined
    if (!scroller || !tab) return
    scroller.scrollLeft = scrollLeftToReveal(
      { scrollLeft: scroller.scrollLeft, viewWidth: scroller.clientWidth },
      { start: tab.offsetLeft, width: tab.offsetWidth }
    )
  }, [activeTabId])

  const commitRename = async (tab: TabInfo, draft: string): Promise<void> => {
    setRenamingId(null)
    const name = renamedValue(draft, tab.name)
    if (name === null) return
    const result = await window.refract.terminal.rename(tab.id, name)
    if (!result.ok) {
      setRenameError(result.error.message)
      return
    }
    setRenameError(null)
    useTerminalStore.getState().applyTabState({ sessionId, tab: result.value })
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>, tab: TabInfo, index: number): void => {
    if (event.key === 'F2') {
      event.preventDefault()
      setRenamingId(tab.id)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      close.requestClose(tab)
      return
    }
    const next = tabIndexForKey(event.key, index, tabs.length)
    const target = next === null ? undefined : tabs[next]
    if (!target) return
    event.preventDefault()
    onSelect(target.id)
    tabRefs.current.get(target.id)?.focus()
  }

  return (
    <div className="flex flex-col border-b border-border">
      <div className="flex items-center gap-1 px-1 py-1">
        <div ref={scrollerRef} role="tablist" aria-label="Terminal tabs" className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
          {tabs.map((tab, index) => {
            const selected = tab.id === activeTabId
            const marker = tabMarker(tab.state)
            return (
              <div key={tab.id} role="presentation" className="flex shrink-0 items-center">
                {renamingId === tab.id ? (
                  <RenameField tab={tab} onCommit={(draft) => void commitRename(tab, draft)} onCancel={() => setRenamingId(null)} />
                ) : (
                  <button
                    ref={(el) => {
                      if (el) tabRefs.current.set(tab.id, el)
                      else tabRefs.current.delete(tab.id)
                    }}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    title="Double-click or press F2 to rename"
                    className={cn('inline-flex max-w-40 items-center gap-2 px-2 py-1 text-sm font-medium', INSET_FOCUS_OUTLINE_CLASS, TAB_LOOK_CLASS)}
                    onClick={() => onSelect(tab.id)}
                    onDoubleClick={() => setRenamingId(tab.id)}
                    onKeyDown={(event) => onTabKeyDown(event, tab, index)}
                  >
                    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', MARKER_DOT[marker.tone])} />
                    <span className="truncate">{tab.name}</span>
                    {marker.label && <span className="sr-only">, {marker.label}</span>}
                  </button>
                )}
                <IconButton label={`Close ${tab.name}`} size="icon-xs" className="text-muted-foreground hover:text-foreground" onClick={() => close.requestClose(tab)}>
                  <XIcon aria-hidden />
                </IconButton>
              </div>
            )
          })}
        </div>
        <IconButton label={addLabel} aria-disabled={atLimit || adding} onClick={() => !atLimit && !adding && onAdd()}>
          <PlusIcon aria-hidden />
        </IconButton>
      </div>
      {(renameError || close.error) && (
        <InlineStatus tone="error" density="compact" className="px-2 pb-1">
          {renameError ?? close.error}
        </InlineStatus>
      )}
      {close.prompt}
    </div>
  )
}

interface RenameFieldProps {
  tab: TabInfo
  onCommit(draft: string): void
  onCancel(): void
}

function RenameField({ tab, onCommit, onCancel }: RenameFieldProps) {
  const [draft, setDraft] = useState(tab.name)
  // Enter commits and unmounts the field, whose blur would commit a second time.
  const settled = useRef(false)
  const settle = (commit: boolean): void => {
    if (settled.current) return
    settled.current = true
    if (commit) onCommit(draft)
    else onCancel()
  }
  return (
    <input
      autoFocus
      aria-label={`Rename ${tab.name}`}
      value={draft}
      maxLength={NAME_MAX_CHARS}
      className="h-6 w-32 rounded-sm border border-input bg-background px-1 text-sm text-foreground outline-none focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-ring"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') settle(true)
        else if (event.key === 'Escape') settle(false)
        event.stopPropagation()
      }}
    />
  )
}
