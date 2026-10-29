// #746: the ChatPane stop/failure banner (Terminated unexpectedly, The agent stopped, start-failed,
// Worktree missing) on the shared `PaneBanner`. `data-pane-banner` sits on the wrapper so
// `focusPaneContent` (lib/focus.ts) focuses the first enabled button, which is always the primary.
import type { Ref } from 'react'
import { PaneBanner } from '@/components/PaneBanner'
import { Button } from '@/components/ui/button'

type StopReason = string | undefined

interface StopBannerProps {
  stopReason: StopReason
  stopDetail?: string
  showTerminatedTitle: boolean
  pendingToolNames?: string[]
  canResume: boolean
  busy: { recovering: boolean; startingNew: boolean; resuming: boolean }
  startFailureDetails?: string
  detailsOpen: boolean
  detailsId: string
  onToggleDetails: () => void
  onRecover: () => void
  onResume: () => void
  onStartNew: () => void
  onRecreateWorktree: () => void
  onArchive: () => void
  onDelete: () => void
  startNewButtonRef: Ref<HTMLButtonElement>
  deleteButtonRef: Ref<HTMLButtonElement>
}

function bannerText(
  reason: StopReason,
  detail: string | undefined,
  terminated: boolean,
  pending?: string[]
): { title: string; detail?: string; prose?: boolean } {
  if (terminated) {
    const waiting = pending && pending.length > 0 ? ` Still waiting on ${pending.join(', ')}.` : ''
    return { title: 'Terminated unexpectedly', detail: `Its Conversation ended mid-turn, not a clean stop.${waiting}`, prose: true }
  }
  switch (reason) {
    case 'agent-exited':
      return { title: 'The agent stopped', detail: `Exit code: ${detail ?? 'unknown'}` }
    case 'worktree-missing':
      return { title: "This Session's worktree is missing", detail: detail ?? 'The worktree folder is gone' }
    case 'start-failed':
      // Only the first line is the title; the rest is the Details disclosure.
      return { title: detail?.split('\n', 1)[0] || 'The agent failed to start' }
    default:
      return { title: 'The agent is stopped' }
  }
}

export function StopBanner(p: StopBannerProps) {
  const { recovering, startingNew, resuming } = p.busy
  const text = bannerText(p.stopReason, p.stopDetail, p.showTerminatedTitle, p.pendingToolNames)
  return (
    <div data-pane-banner className="shrink-0 px-4 pt-4">
      <PaneBanner title={text.title} detail={text.detail} detailMono={!text.prose}>
        {p.canResume && (
          <>
            {p.stopReason === 'agent-exited' && (
              <Button size="sm" variant="outline" disabled={recovering || startingNew || resuming} onClick={p.onRecover}>
                {recovering ? 'Retrying…' : 'Recover'}
              </Button>
            )}
            <Button
              size="sm"
              variant={p.stopReason === 'agent-exited' ? 'text' : 'outline'}
              aria-disabled={recovering || startingNew || resuming || undefined}
              className="aria-disabled:opacity-50"
              onClick={p.onResume}
            >
              {resuming ? 'Resuming…' : 'Resume'}
            </Button>
          </>
        )}
        {p.stopReason === 'start-failed' && (
          <>
            <Button size="sm" variant="outline" disabled={recovering || startingNew} onClick={p.onRecover}>
              {recovering ? 'Retrying…' : 'Retry'}
            </Button>
            <Button ref={p.startNewButtonRef} size="sm" variant="text" disabled={recovering || startingNew} onClick={p.onStartNew}>
              {startingNew ? 'Starting…' : 'Start new conversation'}
            </Button>
          </>
        )}
        {p.stopReason === 'worktree-missing' && (
          <>
            <Button size="sm" variant="outline" onClick={p.onRecreateWorktree}>
              Recreate worktree
            </Button>
            <Button size="sm" variant="text" onClick={p.onArchive}>
              Archive
            </Button>
            <Button ref={p.deleteButtonRef} size="sm" variant="text-destructive" onClick={p.onDelete}>
              Delete
            </Button>
          </>
        )}
      </PaneBanner>
      {/* Outside the alert: toggling must not re-announce it (a11y cycle 6). */}
      {p.startFailureDetails && (
        <div className="mt-2 pl-6 pb-4">
          <button
            type="button"
            aria-expanded={p.detailsOpen}
            aria-controls={p.detailsId}
            onClick={p.onToggleDetails}
            className="inline-flex min-h-11 items-center px-1 text-xs underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Details
          </button>
          {/* Always mounted so aria-controls never dangles; role=region makes the aria-label valid. */}
          <pre
            id={p.detailsId}
            hidden={!p.detailsOpen}
            role="region"
            tabIndex={0}
            aria-label="Start failure details"
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words p-1 text-xs text-muted-foreground outline-none focus-visible:outline-hidden focus-visible:outline-offset-[-2px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {p.startFailureDetails}
          </pre>
        </div>
      )}
    </div>
  )
}
