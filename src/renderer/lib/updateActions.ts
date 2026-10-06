import { useCallback, useState } from 'react'
import { useUpdateStore } from '@/state'
import type { UpdateState } from '../../shared/ipc'

// Shared between StatusBar.tsx's update badge/popover and the Settings screen's Updates
// section (spec 006 FR-012/FR-017 roadmap item 4: "the same Update/Retry actions as the
// badge") -- one place owns the install/retry sequencing and plain-words copy so the two
// surfaces can never drift from each other.

/** The exact install-not-finished message resolveInstallingState (main/update/installOnQuit.ts)
 * writes -- the one 'failed' case that is not a download/checksum failure, used to pick between
 * "Update didn't install" and "Update failed" below. */
const INSTALL_DID_NOT_FINISH = 'The update did not finish installing. The previous version is still running.'

/** Quality-gate remediation (UI Medium "the failed state shows the wrong message"): a check
 * never produces 'failed' (UpdateChecker.ts always resolves to 'idle' with unavailableReason,
 * 'available', or passes phase through unchanged) -- only a download/checksum failure
 * (UpdateInstaller.ts) or a failed install-on-quit (installOnQuit.ts) ever does. */
export function failedUpdateTitle(state: UpdateState): string {
  return state.lastError === INSTALL_DID_NOT_FINISH ? "Update didn't install" : 'Update failed'
}

/** Short text for the status-bar chip itself (DESIGN.md "Layout"). */
export function updateBadgeText(state: UpdateState): string {
  switch (state.phase) {
    case 'available':
      return `${state.availableVersion} available`
    case 'downloading':
      return `Downloading ${state.availableVersion}…`
    case 'downloaded':
      return `${state.availableVersion} downloaded`
    case 'installing':
      return 'Installing…'
    case 'failed':
      return failedUpdateTitle(state)
    default:
      return ''
  }
}

/** The fuller sentence a screen reader hears on each phase change (spec 006 FR-012, A11y High
 * "the badge mounts when the phase leaves checking... None of this is inside a live region"). */
export function updateAnnouncementText(state: UpdateState): string {
  switch (state.phase) {
    case 'available':
      return `Refract ${state.availableVersion} is available`
    case 'downloading':
      return `Downloading ${state.availableVersion}`
    case 'downloaded':
      return `${state.availableVersion} downloaded. Quit Refract to finish installing.`
    case 'installing':
      return 'Installing the update'
    case 'failed':
      return state.lastError ? `${failedUpdateTitle(state)}: ${state.lastError}` : failedUpdateTitle(state)
    default:
      return ''
  }
}

/** Plain-words FR-017 mapping for Settings' Updates section -- 'Refract is up to date.' is the
 * one case with no unavailableReason at all (a real check ran, found nothing newer). */
export function updateStatusText(state: UpdateState): string {
  if (state.unavailableReason === 'not-installed') return 'GitHub CLI is not installed.'
  if (state.unavailableReason === 'not-signed-in') return 'GitHub CLI is not signed in. Run gh auth login.'
  if (state.unavailableReason === 'offline') return 'Could not reach GitHub.'
  if (state.phase === 'idle' && state.lastCheckedAt) return 'Refract is up to date.'
  return 'Not checked yet.'
}

export async function checkForUpdates(): Promise<void> {
  const result = await window.refract.updates.check()
  if (result.ok) useUpdateStore.getState().setState(result.value)
}

async function installUpdate(): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await window.refract.updates.install()
  if (!result.ok) return { ok: false, message: result.error.message }
  return { ok: true }
}

/** The failed state's own 'Try again' (UI roadmap item 2: "replace the dead Update button"):
 * re-checks first (covers "the release might already be gone/replaced"), then installs only if
 * that check finds an available update again. */
async function retryUpdate(): Promise<{ ok: true } | { ok: false; message: string }> {
  await checkForUpdates()
  if (useUpdateStore.getState().state.phase === 'available') return installUpdate()
  return { ok: true }
}

/** Shared busy/error bookkeeping for the one Update/Retry button both StatusBar.tsx's popover
 * and UpdatesSection.tsx render -- neither duplicates the try/catch-free Result handling. */
export function useUpdateInstallAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runInstall = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await installUpdate()
      if (!result.ok) setError(result.message)
    } catch (err) {
      console.debug('[refract] updates.install: invoke failed', err)
      setError('The update could not install. Try again.')
    } finally {
      setBusy(false)
    }
  }, [])

  const runRetry = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await retryUpdate()
      if (!result.ok) setError(result.message)
    } catch (err) {
      console.debug('[refract] updates retry: invoke failed', err)
      setError('The update could not install. Try again.')
    } finally {
      setBusy(false)
    }
  }, [])

  return { busy, error, runInstall, runRetry }
}
