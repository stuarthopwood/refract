// #746: the ChatPane stop/failure banner (Terminated unexpectedly, The agent stopped, start-failed,
// Worktree missing) on the shared `PaneBanner`. `data-pane-banner` sits on the wrapper so
// `focusPaneContent` (lib/focus.ts) focuses the first enabled button, which is always the primary.
import { useId } from 'react'
import type { Ref } from 'react'
import { PaneBanner } from '@/components/PaneBanner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { disclosureToggleClassName } from './linkStyles'

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

const BUSY_CLASS = 'aria-disabled:opacity-50'
const guard = (busy: boolean, fn: () => void) => () => {
  if (!busy) fn()
}

export function StopBanner(p: StopBannerProps) {
  const { recovering, startingNew, resuming } = p.busy
  const busyAny = recovering || startingNew || resuming
  const busyStart = recovering || startingNew
  const text = bannerText(p.stopReason, p.stopDetail, p.showTerminatedTitle, p.pendingToolNames)
  const titleId = useId()
  return (
    <div
      data-pane-banner
      role="group"
      tabIndex={-1}
      aria-labelledby={titleId}
      className={cn(
        'shrink-0 px-4 pt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-solid forced-colors:focus-visible:-outline-offset-2',
        // Without the details block the banner has no bottom content to supply spacing.
        !p.startFailureDetails && 'pb-2'
      )}
    >
      <PaneBanner title={text.title} titleId={titleId} detail={text.detail} detailMono={!text.prose}>
        {p.canResume && (
          <>
            {p.stopReason === 'agent-exited' && (
              <Button size="xs" variant="outline" aria-disabled={busyAny || undefined} className={BUSY_CLASS} onClick={guard(busyAny, p.onRecover)}>
                {recovering ? 'Retrying…' : 'Recover'}
              </Button>
            )}
            <Button
              size="xs"
              variant={p.stopReason === 'agent-exited' ? 'text' : 'outline'}
              aria-disabled={busyAny || undefined}
              className={BUSY_CLASS}
              onClick={guard(busyAny, p.onResume)}
            >
              {resuming ? 'Resuming…' : 'Resume'}
            </Button>
          </>
        )}
        {p.stopReason === 'start-failed' && (
          <>
            <Button size="xs" variant="outline" aria-disabled={busyStart || undefined} className={BUSY_CLASS} onClick={guard(busyStart, p.onRecover)}>
              {recovering ? 'Retrying…' : 'Retry'}
            </Button>
            <Button ref={p.startNewButtonRef} size="xs" variant="text" aria-disabled={busyStart || undefined} className={BUSY_CLASS} onClick={guard(busyStart, p.onStartNew)}>
              {startingNew ? 'Starting…' : 'Start new conversation'}
            </Button>
          </>
        )}
        {p.stopReason === 'worktree-missing' && (
          <>
            <Button size="xs" variant="outline" onClick={p.onRecreateWorktree}>
              Recreate worktree
            </Button>
            <Button size="xs" variant="text" onClick={p.onArchive}>
              Archive
            </Button>
            <Button ref={p.deleteButtonRef} size="xs" variant="text-destructive" onClick={p.onDelete}>
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
            className={disclosureToggleClassName}
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
