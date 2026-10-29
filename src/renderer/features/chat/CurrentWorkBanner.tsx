// Issue #687 (spec 004 FR-035 to FR-040, FR-042): the current-work banner, one line directly above
// the composer: the label in the accent text colour with the shared shimmer while
// the Session is working (static when it needs you; the sweep is not restarted by a label change).
// No elapsed time (FR-039, issue #1250): the turn-time chip and the transcript's turn total carry it.
// Shown while the Session is working or needs you, hidden when idle, gated by
// `sessionReadout['current-work']`. One per ChatPane (each split pane mounts its own, keyed by
// `sessionId`). Text comes from the shared pure `deriveActivity` (src/shared/activity.ts) and is
// rendered as plain text only. No spinner, no stop control (the composer and chat header already
// carry both); `aria-live="off"`, so a screen reader is never interrupted by it.
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSessionsStore, useSettingsStore, useTodoPinStore } from '@/state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FadeCollapse } from '@/components/FadeCollapse'
import { ShimmerText } from '@/components/ShimmerText'
import { deriveActivity } from '../../../shared/activity'
import { deriveCurrentTask, deriveTodoTotals } from './readout/todoDerive'
import { useHeldActivityText, usePendingActivity } from './useHeldActivityText'

export function CurrentWorkBanner({ sessionId }: { sessionId: string }) {
  const enabled = useSettingsStore((s) => s.settings.sessionReadout['current-work'])
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const readout = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout)
  const pinned = useTodoPinStore((s) => s.pinnedBySession[sessionId] ?? false)
  const pending = usePendingActivity(sessionId)

  const visible = enabled && (status === 'working' || status === 'needs-you')
  const totals = pinned ? null : deriveTodoTotals(readout.todoTree)
  const current = pinned ? null : deriveCurrentTask(readout.todoTree)
  const activity = deriveActivity({
    needsYou: status === 'needs-you',
    pending,
    runningSubagents: readout.subagentCount?.running ?? 0,
    todo: totals && current ? { number: totals.done + 1, total: totals.total, content: current.task.content } : null,
    latestIntent: readout.latestIntent,
    latestTool: readout.latestTool,
    retry: null, // RetryLine owns the retry text
    compacting: readout.compacting
  })
  const text = useHeldActivityText(sessionId, visible ? activity : null)

  if (!visible || text === null) return <FadeCollapse show={false}>{null}</FadeCollapse>
  return (
    <FadeCollapse show>
    <div
      data-slot="current-work-banner"
      data-testid="current-work-banner"
      aria-live="off"
      className="flex h-6 shrink-0 items-center px-4 text-sm"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-describedby={undefined}
            data-testid="current-work-banner-text"
            className="block min-w-0 flex-1 truncate text-accent-text"
          >
            <ShimmerText
              key={status === 'working' ? 'working' : text}
              active={status === 'working'}
              className="animate-in fade-in-0 duration-150 motion-reduce:animate-none"
            >
              {text}
            </ShimmerText>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-md break-words">{text}</TooltipContent>
      </Tooltip>
    </div>
    </FadeCollapse>
  )
}
