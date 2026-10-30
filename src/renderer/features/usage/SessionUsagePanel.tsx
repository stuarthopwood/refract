// The Session usage right-pane panel (spec 070 FR-4): usage for the focused Session only, from the
// per-Session store. Mounted only while the panel is active, so mount starts the rescan and
// unmount stops it, like the Usage view.
import { useEffect } from 'react'
import { CompactList } from '@/components/CompactList'
import type { CompactListItem } from '@/components/CompactList'
import { ProgressStrip } from '@/components/ProgressStrip'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { SESSION_CALLS_STEP, useSessionUsageStore } from '@/state/session-usage-store'
import { useSessionsStore, useViewStore } from '@/state'
import type { UsageBreakdownRow } from '../../../shared/ipc-usage'
import { callToListItem } from './callLogRow'
import { formatCompact, formatInt, formatPercent, formatUsd } from './format'
import { HeadlineCards } from './HeadlineCards'
import { SpendChart } from './SpendChart'
import { TokenMixChart } from './TokenMixChart'

const breakdownItems = (rows: UsageBreakdownRow[], value: (row: UsageBreakdownRow) => string): CompactListItem[] =>
  rows.slice(0, 8).map((row) => ({
    key: `${row.label}:${row.reasoning ?? ''}`,
    label: row.label,
    caption: row.reasoning || undefined,
    value: value(row)
  }))

export function SessionUsagePanel({ sessionId }: { sessionId: string | null }) {
  const sessionDir = useSessionsStore((s) => (sessionId ? (s.sessions.find((x) => x.id === sessionId)?.sessionDir ?? null) : null))
  const entry = useSessionUsageStore((s) => (sessionDir ? s.entries[sessionDir] : undefined))
  const status = useSessionUsageStore((s) => s.status)
  const budget = useSessionUsageStore((s) => s.budget)
  const openUsage = useViewStore((s) => s.openUsage)

  useEffect(() => {
    void useSessionUsageStore.getState().start()
    return () => useSessionUsageStore.getState().stop()
  }, [])
  useEffect(() => {
    if (sessionDir) void useSessionUsageStore.getState().refresh(sessionDir)
  }, [sessionDir])

  if (!sessionId || !sessionDir) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Focus a session to see its usage</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }
  const showProgress = status !== null && (status.running || (status.sessionsSeen > 0 && status.sessionsDone < status.sessionsSeen))
  const unavailable = status !== null && !status.running && !status.found
  const summary = entry?.summary ?? null
  const noCalls = entry?.loaded === true && summary !== null && summary.calls === 0 && !showProgress

  let body
  if (unavailable) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Usage is unavailable</EmptyTitle>
          <EmptyDescription>No Copilot session history was found at {status.sessionsDir}.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  } else if (noCalls) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No usage yet in this session</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  } else if (entry && summary) {
    const copilot = budget?.copilot ?? null
    const share = copilot?.entitlement && entry.periodCredits !== null ? entry.periodCredits / copilot.entitlement : null
    const hasCache = entry.tokenMix.length > 0
    body = (
      <>
        {entry.error && <ScreenSection title="Usage figures" error={`Some figures could not be loaded: ${entry.error}`} />}
        <HeadlineCards summary={summary} jokes={false} layout="stacked" />
        <p className="text-xs text-muted-foreground">
          {share !== null
            ? `${formatPercent(share)} of this month's AI credit budget (${formatInt(entry.periodCredits ?? 0)} of ${formatInt(copilot?.entitlement ?? 0)})`
            : `Budget share hidden: ${budget?.unavailable ?? (copilot ? 'the reset date or entitlement is unknown' : 'no Copilot budget is available')}.`}
        </p>
        <SpendChart compact buckets={entry.timeseries} />
        {hasCache && <TokenMixChart rows={entry.tokenMix} />}
        <ScreenSection title="By model" empty={entry.byModel.length === 0 ? 'No models yet.' : null}>
          <CompactList label="Spend by model" items={breakdownItems(entry.byModel, (r) => formatUsd(r.usd))} />
        </ScreenSection>
        <ScreenSection title="By tool" empty={entry.byTool.length === 0 ? 'No tool calls yet.' : null}>
          <CompactList label="Tool calls" items={breakdownItems(entry.byTool, (r) => `${formatCompact(r.calls)} calls`)} />
        </ScreenSection>
        <ScreenSection title="Recent calls" count={entry.callsTotal}>
          <CompactList
            label="Recent model calls, newest first"
            items={entry.calls.map((row) => callToListItem(row))}
            footer={
              entry.calls.length < entry.callsTotal && entry.callsLimit < 100 ? (
                <Button variant="link" className="self-start px-0" onClick={() => useSessionUsageStore.getState().showMore(sessionDir)}>
                  Show more ({SESSION_CALLS_STEP} more)
                </Button>
              ) : undefined
            }
          />
        </ScreenSection>
      </>
    )
  } else {
    body = <ScreenSection title="Session usage" loading />
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden p-2">
        {showProgress && status && (
          <ProgressStrip
            value={status.sessionsDone}
            max={status.sessionsSeen}
            label={`Reading sessions: ${status.sessionsDone} of ${status.sessionsSeen}`}
          />
        )}
        {body}
      </div>
      <div className="border-t border-border px-2 py-2">
        <Button variant="link" className="px-0" onClick={openUsage}>
          Open in Usage
        </Button>
      </div>
    </div>
  )
}
