// Issue #687 (spec 004 FR-035 to FR-040): the current-work banner, one muted line directly above
// the composer. Shown while the Session is working or needs you, hidden when idle, gated by
// `sessionReadout['current-work']`. One per ChatPane (each split pane mounts its own, keyed by
// `sessionId`). Text comes from the shared pure `deriveActivity` (src/shared/activity.ts) and is
// rendered as plain text only. No spinner, no stop control (the composer and chat header already
// carry both); `aria-live="off"`, so a screen reader is never interrupted by it.
import { useEffect, useRef, useState } from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSessionsStore, useSettingsStore, useTodoPinStore } from '@/state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { deriveActivity } from '../../../shared/activity'
import { formatElapsed } from './formatElapsed'
import { deriveCurrentTask, deriveTodoTotals } from './readout/todoDerive'

// Each line stays on screen at least this long, so the banner changes at most ~1.7 times a second.
const MIN_HOLD_MS = 600

function useHeldText(next: string | null): string | null {
  const [shown, setShown] = useState(next)
  const shownAtRef = useRef(Date.now())
  useEffect(() => {
    if (next === shown) return
    const wait = next === null || shown === null ? 0 : Math.max(0, shownAtRef.current + MIN_HOLD_MS - Date.now())
    const timer = setTimeout(() => {
      shownAtRef.current = Date.now()
      setShown(next)
    }, wait)
    return () => clearTimeout(timer)
  }, [next, shown])
  return shown
}

function useElapsedMs(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? null : now - startedAt
}

export function CurrentWorkBanner({ sessionId }: { sessionId: string }) {
  const enabled = useSettingsStore((s) => s.settings.sessionReadout['current-work'])
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const readout = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout)
  const pinned = useTodoPinStore((s) => s.pinnedBySession[sessionId] ?? false)

  const visible = enabled && (status === 'working' || status === 'needs-you')
  const totals = pinned ? null : deriveTodoTotals(readout.todoTree)
  const current = pinned ? null : deriveCurrentTask(readout.todoTree)
  const activity = deriveActivity({
    needsYou: status === 'needs-you',
    runningSubagents: readout.subagentCount?.running ?? 0,
    todo: totals && current ? { number: totals.done + 1, total: totals.total, content: current.task.content } : null,
    latestIntent: readout.latestIntent,
    latestTool: readout.latestTool,
    retry: readout.retry,
    compacting: readout.compacting
  })
  const text = useHeldText(visible ? activity.text : null)
  const elapsedMs = useElapsedMs(visible ? (readout.turnTime?.startedAt ?? null) : null)

  if (!visible || text === null) return null
  return (
    <div
      data-slot="current-work-banner"
      data-testid="current-work-banner"
      aria-live="off"
      className="flex h-6 shrink-0 items-center gap-1.5 px-4 text-xs text-muted-foreground"
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
            key={text}
            aria-describedby={undefined}
            data-testid="current-work-banner-text"
            className="min-w-0 flex-1 truncate animate-in fade-in-0 duration-150 motion-reduce:animate-none"
          >
            {text}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-md break-words">{text}</TooltipContent>
      </Tooltip>
    </div>
  )
}
