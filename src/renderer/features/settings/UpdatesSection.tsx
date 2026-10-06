// Spec 006 FR-012/FR-017 roadmap item 4: a permanent, always-reachable home for Check for
// updates and the plain-words unavailableReason/up-to-date result -- the status-bar badge
// (StatusBar.tsx) stays an alert that only shows once an update actually exists/is downloading/
// downloaded/failed (research.md decision 11), so this section is the only place FR-012's "has
// Refract already checked, and did it find anything" question is always answerable. Shares
// UpdateActionRow (and the busy/error bookkeeping in lib/updateActions.ts) with StatusBar.tsx's
// own popover, so the same phase always shows the same action.
import { useEffect, useRef, useState } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { checkForUpdates, updateStatusText, useUpdateInstallAction } from '@/lib/updateActions'
import { useUpdateStore } from '@/state'
import { UpdateActionRow } from '../updates/UpdateActionRow'

function formatCheckedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function UpdatesSection() {
  const updateState = useUpdateStore((state) => state.state)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const { busy: installBusy, error: installError, runInstall, runRetry } = useUpdateInstallAction()
  const [announcement, announce] = useClearedAnnouncement()
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Matches SettingsScreen.tsx's own "Session readout" heading-focus pattern: this component
  // mounts fresh every time the developer switches to this section.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.refract.app.getVersion()
      if (!cancelled && result.ok) setAppVersion(result.value)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleCheck(): Promise<void> {
    setChecking(true)
    try {
      await checkForUpdates()
      announce(updateStatusText(useUpdateStore.getState().state))
    } catch (error) {
      console.debug('[refract] updates.check: invoke failed', error)
      announce('Could not check for updates.')
    } finally {
      setChecking(false)
    }
  }

  const hasAction =
    updateState.phase === 'available' ||
    updateState.phase === 'downloading' ||
    updateState.phase === 'downloaded' ||
    updateState.phase === 'installing' ||
    updateState.phase === 'failed'
  // Mirrors StatusBar.tsx's own updateBusyPhase: main's updates.check() is already a no-op in
  // these three phases (contracts/ipc.md), hidden here too so the button never looks clickable
  // mid-download/mid-install.
  const checkBusyPhase = updateState.phase === 'downloading' || updateState.phase === 'installing' || updateState.phase === 'downloaded'

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Updates
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">Installed version: {appVersion ?? '…'}</p>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{updateStatusText(updateState)}</span>
            {updateState.lastCheckedAt && (
              <span className="text-xs text-muted-foreground">Last checked at {formatCheckedAt(updateState.lastCheckedAt)}.</span>
            )}
          </div>
          {!checkBusyPhase && (
            <Button
              size="sm"
              variant="outline"
              aria-disabled={checking || undefined}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={() => {
                if (!checking) void handleCheck()
              }}
            >
              {checking && <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />}
              Check for updates
            </Button>
          )}
        </div>
        {hasAction && (
          <UpdateActionRow
            state={updateState}
            busy={installBusy}
            installError={installError}
            onInstall={() => void runInstall()}
            onRetry={() => void runRetry()}
          />
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
