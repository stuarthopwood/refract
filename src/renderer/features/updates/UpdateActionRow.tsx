import { LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { UpdateState } from '../../../shared/ipc'
import { failedUpdateTitle } from '@/lib/updateActions'

export interface UpdateActionRowProps {
  state: UpdateState
  busy: boolean
  installError: string | null
  onInstall: () => void
  onRetry: () => void
}

// Quality-gate remediation (UI Medium "the failed state is a dead end", "the downloaded state
// doesn't say what quitting will do"): the one place that renders an update's own action for
// its current phase, shared by StatusBar.tsx's popover and the Settings screen's Updates
// section (roadmap item 4: "the same Update/Retry actions as the badge") so the two surfaces
// can never show a different action for the same phase.
export function UpdateActionRow({ state, busy, installError, onInstall, onRetry }: UpdateActionRowProps) {
  if (state.phase === 'downloaded') {
    return (
      <p className="text-xs text-muted-foreground">
        Quit Refract to finish installing. Running agents stop when you quit. Refract does not reopen by itself.
      </p>
    )
  }
  if (state.phase === 'downloading' || state.phase === 'installing') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
        {state.phase === 'downloading' ? `Downloading ${state.availableVersion ?? ''}…` : 'Installing the update…'}
      </p>
    )
  }
  if (state.phase === 'failed') {
    return (
      <div className="flex flex-col items-start gap-1">
        {state.lastError && (
          <p role="alert" className="text-xs text-destructive">
            {failedUpdateTitle(state)}: {state.lastError}
          </p>
        )}
        {installError && (
          <p role="alert" className="text-xs text-destructive">
            {installError}
          </p>
        )}
        <Button
          size="sm"
          variant="default"
          aria-disabled={busy || undefined}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => {
            if (!busy) onRetry()
          }}
        >
          {busy && <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />}
          Try again
        </Button>
      </div>
    )
  }
  if (state.phase === 'available') {
    return (
      <div className="flex flex-col items-start gap-1">
        {installError && (
          <p role="alert" className="text-xs text-destructive">
            {installError}
          </p>
        )}
        <Button
          size="sm"
          variant="default"
          aria-disabled={busy || undefined}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => {
            if (!busy) onInstall()
          }}
        >
          {busy && <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />}
          Update
        </Button>
      </div>
    )
  }
  return null
}
