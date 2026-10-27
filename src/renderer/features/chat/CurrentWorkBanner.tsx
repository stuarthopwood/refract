// Issue #687 (spec 004 FR-035 to FR-040, FR-042): the current-work banner, one line directly above
// the composer: elapsed time muted, label in the accent text colour with the shared shimmer while
// the Session is working (static when it needs you). Shown while the Session is working or needs you, hidden when idle, gated by
// `sessionReadout['current-work']`. One per ChatPane (each split pane mounts its own, keyed by
// `sessionId`). Text comes from the shared pure `deriveActivity` (src/shared/activity.ts) and is
// rendered as plain text only. No spinner, no stop control (the composer and chat header already
// carry both); `aria-live="off"`, so a screen reader is never interrupted by it.
import { useEffect, useState } from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSessionsStore, useSettingsStore, useTodoPinStore } from '@/state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShimmerText } from '@/components/ShimmerText'
import { deriveActivity } from '../../../shared/activity'
import { formatElapsed } from './formatElapsed'
import { deriveCurrentTask, deriveTodoTotals } from './readout/todoDerive'
import { useHeldActivityText, usePendingActivity } from './useHeldActivityText'


function useElapsedMs(startedAt: number | null): number | null {
  const [tick, setTick] = useState(() => ({ startedAt, now: Date.now() }))
  useEffect(() => {
    if (startedAt === null) return
    setTick({ startedAt, now: Date.now() })
    const timer = setInterval(() => setTick({ startedAt, now: Date.now() }), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) return null
  const now = tick.startedAt === startedAt ? tick.now : Date.now()
  return Math.max(0, now - startedAt)
}

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
    retry: readout.retry,
    compacting: readout.compacting
  })
  const text = useHeldActivityText(sessionId, visible ? activity : null)
  const elapsedMs = useElapsedMs(visible ? (readout.turnTime?.startedAt ?? null) : null)

  if (!visible || text === null) return null
  return (
    <div
      data-slot="current-work-banner"
      data-testid="current-work-banner"
      aria-live="off"
      className="mb-1 flex h-6 shrink-0 items-center gap-1.5 px-4 text-sm text-muted-foreground"
    >
      {elapsedMs !== null && (
        <>
          <span className="shrink-0 tabular-nums">{formatElapsed(elapsedMs)}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-describedby={undefined}
            data-testid="current-work-banner-text"
            className="block min-w-0 flex-1 truncate text-accent-text"
          >
            <ShimmerText
              key={text}
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
  )
}
