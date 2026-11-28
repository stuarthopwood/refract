import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { InlineStatus } from '@/components/InlineStatus'
import { activeTab, selectSessionTerminals, useTerminalStore } from '@/state/terminal-store'
import { TerminalTabStrip } from './TerminalTabStrip'
import { TerminalView } from './TerminalView'

// The right-pane terminal: the Session's tabs and the one live view of the shown tab (spec 144 FR-001, FR-002).
// Leaving the panel unmounts the view, which only detaches; no tab is ever closed from here (FR-008).

/** The size a first tab starts with; the view's `attach` sends the measured size straight after. */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

interface TerminalPanelProps {
  sessionId: string | null
}

export function TerminalPanel({ sessionId }: TerminalPanelProps) {
  if (sessionId === null) {
    return (
      <InlineStatus tone="info" density="block">
        Open a Session to use a terminal.
      </InlineStatus>
    )
  }
  return <SessionTerminal key={sessionId} sessionId={sessionId} />
}

function SessionTerminal({ sessionId }: { sessionId: string }) {
  const session = useTerminalStore((s) => selectSessionTerminals(s, sessionId))
  const tab = activeTab(session)
  const [adding, setAdding] = useState(false)
  const focusRef = useRef<(() => void) | null>(null)
  // A strict-mode remount or a quick re-render must not create the first tab twice.
  const autoCreated = useRef(false)

  useEffect(() => {
    void useTerminalStore.getState().load(sessionId)
  }, [sessionId])

  const create = useCallback(async () => {
    setAdding(true)
    try {
      await useTerminalStore.getState().create(sessionId, INITIAL_COLS, INITIAL_ROWS)
    } finally {
      setAdding(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!session.loaded || session.tabs.length > 0 || session.error || autoCreated.current) return
    autoCreated.current = true
    void create()
  }, [session.loaded, session.tabs.length, session.error, create])

  const retry = (): void => {
    // A cleared error with no tab left lets the effect above create the first one again.
    autoCreated.current = false
    void useTerminalStore.getState().load(sessionId, true)
  }

  return (
    <section aria-label="Terminal" className="flex min-h-0 flex-1 flex-col">
      <TerminalTabStrip
        sessionId={sessionId}
        tabs={session.tabs}
        activeTabId={tab?.id ?? null}
        adding={adding}
        onSelect={(tabId) => useTerminalStore.getState().setActive(sessionId, tabId)}
        onAdd={() => void create()}
        restoreFocus={() => {
          const focus = focusRef.current
          focus?.()
          return focus != null
        }}
      />
      {session.error && (
        <div className="flex items-center gap-2 px-2 py-2">
          <InlineStatus tone="error" density="compact" className="min-w-0 flex-1">
            {session.error}
          </InlineStatus>
          <Button size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {!session.loaded && (
        <InlineStatus tone="loading" density="block">
          Loading terminals
        </InlineStatus>
      )}
      {tab && <TerminalView sessionId={sessionId} tab={tab} focusRef={focusRef} />}
    </section>
  )
}
