import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { PlusIcon, XIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { InlineStatus } from '@/components/InlineStatus'
import { TabButton } from '@/components/TabButton'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTerminalStore } from '@/state/terminal-store'
import type { TabInfo } from '../../../shared/ipc-terminal'
import { MAX_TABS_PER_SESSION, NAME_MAX_CHARS } from '../../../shared/terminalLimits'
import { scrollLeftToReveal } from '../right-pane/tab-strip-scroll'
import { useCloseFlow } from './ClosePrompt'
import { panelDomId, renameOutcome, tabDomId, tabIndexForKey, tabMarker, type RenameEnd, type TabMarker } from './terminalTabs'
import { returnFocus } from './terminalKeyboard'

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
  /** Hands the keyboard to the terminal after the close prompt; `false` when no terminal is mounted to take it. */
  restoreFocus(): boolean
}

export function TerminalTabStrip({ sessionId, tabs, activeTabId, adding, onSelect, onAdd, restoreFocus }: TerminalTabStripProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLElement>())
  const addRef = useRef<HTMLButtonElement>(null)
  // A tab the keyboard left for its rename field takes it back when the field closes.
  const refocusTabId = useRef<string | null>(null)
  // With the last tab gone there is no terminal to focus, so the add button holds the keyboard.
  const returnToTerminal = useCallback(() => returnFocus(restoreFocus, () => addRef.current?.focus()), [restoreFocus])
  const hintId = useId()
  const close = useCloseFlow(sessionId, returnToTerminal)
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

  useEffect(() => {
    const tabId = refocusTabId.current
    if (renamingId !== null || tabId === null) return
    refocusTabId.current = null
    tabRefs.current.get(tabId)?.focus()
  }, [renamingId])

  const settleRename = async (tab: TabInfo, draft: string, end: RenameEnd): Promise<void> => {
    const { name, refocusTab } = renameOutcome(draft, tab.name, end)
    if (refocusTab) refocusTabId.current = tab.id
    setRenamingId(null)
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
      close.requestClose(tab, tabRefs.current.get(tab.id))
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
    // drag-regions-allow: renders in the Terminal panel body, below the right pane's own header, so it never touches App.tsx's strip despite the `border-b` shape.
    <div className="flex flex-col border-b border-border">
      <div className="flex items-center gap-1 px-1 py-1">
        {/* Tabs, their close buttons and the rename field sit in one grid row. The tablist wrapper takes no box of its own, so it
            holds only the tabs while each close button and the rename field stay outside it, next to their tab. */}
        <div ref={scrollerRef} className="relative grid min-w-0 flex-1 auto-cols-max grid-flow-col items-center overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
          <span id={hintId} className="sr-only">
            Press F2 to rename this terminal, or Delete to close it.
          </span>
          <div role="tablist" aria-label="Terminal tabs" className="contents">
            {tabs.map((tab, index) => {
              if (renamingId === tab.id) return null
              const marker = tabMarker(tab.state)
              return (
                <TabButton
                  key={tab.id}
                  ref={(el) => {
                    if (el) tabRefs.current.set(tab.id, el)
                    else tabRefs.current.delete(tab.id)
                  }}
                  ids={{ tabId: tabDomId(tab.id), panelId: panelDomId(tab.id) }}
                  selected={tab.id === activeTabId}
                  aria-keyshortcuts="F2 Delete"
                  aria-describedby={hintId}
                  title="Double-click or press F2 to rename"
                  className="max-w-40 gap-2"
                  style={{ gridColumn: index * 2 + 1, gridRow: 1 }}
                  onClick={() => onSelect(tab.id)}
                  onDoubleClick={() => setRenamingId(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, tab, index)}
                >
                  <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', MARKER_DOT[marker.tone])} />
                  <span className="truncate">{tab.name}</span>
                  {marker.label && <span className="sr-only">, {marker.label}</span>}
                </TabButton>
              )
            })}
          </div>
          {tabs.map((tab, index) => (
            <Fragment key={tab.id}>
              {renamingId === tab.id && (
                <div style={{ gridColumn: index * 2 + 1, gridRow: 1 }}>
                  <RenameField tab={tab} onSettle={(draft, end) => void settleRename(tab, draft, end)} />
                </div>
              )}
              <IconButton
                label={`Close ${tab.name}`}
                size="icon-xs"
                className="mr-1 text-muted-foreground hover:text-foreground"
                style={{ gridColumn: index * 2 + 2, gridRow: 1 }}
                onClick={(event) => close.requestClose(tab, event.currentTarget)}
              >
                <XIcon aria-hidden />
              </IconButton>
            </Fragment>
          ))}
        </div>
        <IconButton ref={addRef} label={addLabel} aria-disabled={atLimit || adding} onClick={() => !atLimit && !adding && onAdd()}>
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
  onSettle(draft: string, end: RenameEnd): void
}

function RenameField({ tab, onSettle }: RenameFieldProps) {
  const [draft, setDraft] = useState(tab.name)
  // Enter commits and unmounts the field, whose blur would settle a second time.
  const settled = useRef(false)
  const settle = (end: RenameEnd): void => {
    if (settled.current) return
    settled.current = true
    onSettle(draft, end)
  }
  return (
    <Input
      autoFocus
      aria-label={`Rename ${tab.name}`}
      value={draft}
      maxLength={NAME_MAX_CHARS}
      className="h-6 w-32 rounded-sm px-1 text-sm"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => settle('blur')}
      onKeyDown={(event) => {
        if (event.key === 'Enter') settle('enter')
        else if (event.key === 'Escape') settle('escape')
        event.stopPropagation()
      }}
    />
  )
}
