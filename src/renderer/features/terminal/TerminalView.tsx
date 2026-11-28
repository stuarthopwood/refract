import { useEffect, useState } from 'react'
import type { MutableRefObject } from 'react'
import { PaneBanner } from '@/components/PaneBanner'
import { InlineStatus } from '@/components/InlineStatus'
import type { TabInfo } from '../../../shared/ipc-terminal'
import { EndedBanner } from './EndedBanner'
import { TerminalContextMenu } from './TerminalContextMenu'
import { useTerminalSession } from './useTerminalSession'

// The one live xterm view for the shown tab. The shell runs in Rust whether or not this is mounted (spec 144 FR-008).

interface TerminalViewProps {
  sessionId: string
  tab: TabInfo
  /** Filled with the view's focus function so the panel can hand the keyboard back after a prompt. */
  focusRef: MutableRefObject<(() => void) | null>
}

export function TerminalView({ sessionId, tab, focusRef }: TerminalViewProps) {
  const [reattachToken, setReattachToken] = useState(0)
  const session = useTerminalSession(sessionId, tab.id, reattachToken)
  const { focus } = session
  useEffect(() => {
    focusRef.current = focus
    return () => {
      focusRef.current = null
    }
  }, [focus, focusRef])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {session.status === 'failed' && <PaneBanner className="p-2" title="The terminal could not connect to its shell." detail={session.message} />}
      <EndedBanner
        sessionId={sessionId}
        tab={tab}
        // A new shell has an empty ring, so the view attaches again to start from a clean screen, then takes the keyboard.
        onRestarted={() => {
          setReattachToken((token) => token + 1)
          session.focus()
        }}
      />
      <TerminalContextMenu sessionId={sessionId} tabId={tab.id} getSelection={session.getSelection} focusTerminal={session.focus}>
        <div className="relative min-h-0 flex-1">
          {session.status === 'starting' && (
            <InlineStatus tone="loading" density="compact" className="absolute inset-x-0 top-0 z-10 px-2 py-1">
              Starting shell
            </InlineStatus>
          )}
          <div ref={session.containerRef} data-terminal-view role="group" aria-label={`${tab.name} terminal`} className="h-full w-full overflow-hidden px-2 pt-1" />
        </div>
      </TerminalContextMenu>
    </div>
  )
}
