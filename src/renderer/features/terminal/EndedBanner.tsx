import { useState } from 'react'
import { PaneBanner } from '@/components/PaneBanner'
import { InlineStatus } from '@/components/InlineStatus'
import { Button } from '@/components/ui/button'
import { useTerminalStore } from '@/state/terminal-store'
import type { TabInfo } from '../../../shared/ipc-terminal'

// A shell that ended or never started says so in words and offers a fresh one in the same tab (spec 144 FR-017, US5).

/** Words for a shell that is no longer running, or null while it is starting or running. */
export function describeShellEnd(tab: TabInfo): { title: string; detail: string | null } | null {
  if (tab.state.kind === 'ended') return { title: `Shell ended with code ${tab.state.code}`, detail: null }
  if (tab.state.kind === 'failed') return { title: 'The shell could not start', detail: tab.state.message }
  return null
}

interface EndedBannerProps {
  sessionId: string
  tab: TabInfo
  /** Called after Rust accepted the restart, so the view attaches to the new, empty shell. */
  onRestarted(): void
}

export function EndedBanner({ sessionId, tab, onRestarted }: EndedBannerProps) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const end = describeShellEnd(tab)

  const restart = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.refract.terminal.restart(tab.id)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      useTerminalStore.getState().applyTabState({ sessionId, tab: result.value })
      onRestarted()
    } finally {
      setBusy(false)
    }
  }

  // The live region stays mounted: one inserted together with its text is announced by only some screen readers.
  return (
    <div role="status">
      {end && (
        <PaneBanner className="border-b border-border p-2" severity="warning" role="none" title={end.title} detail={end.detail}>
          <Button size="sm" variant="outline" aria-disabled={busy} className="aria-disabled:opacity-50" onClick={() => void restart()}>
            Restart shell
          </Button>
        </PaneBanner>
      )}
      {end && error && (
        <InlineStatus tone="error" density="compact" className="px-2 py-1">
          {error}
        </InlineStatus>
      )}
    </div>
  )
}
