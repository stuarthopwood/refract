// Spec 060 S2-14: the top-level Usage view (left nav, same shell as Pull requests and Issues).
// Opening it starts the backfill and the rescan; leaving it stops the rescan. The dashboard fills
// as data arrives, with a progress strip while the first backfill runs.
import { useEffect, useRef } from 'react'
import { ProgressStrip } from '@/components/ProgressStrip'
import { ScreenHeader } from '@/components/ScreenHeader'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { useUsageStore } from '@/state/usage-store'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useViewStore } from '@/state'
import { AverageCards } from './AverageCards'
import { BudgetCard } from './BudgetCard'
import { CallLogTable } from './CallLogTable'
import { FrustrationCard } from './FrustrationCard'
import { HeadlineCards } from './HeadlineCards'
import { SpendChart } from './SpendChart'
import { TokenMixChart } from './TokenMixChart'
import { UsageEmptyState } from './UsageEmptyState'
import { UsageFilters, clearUsageFilters, countActiveFilters } from './UsageFilters'
import { ModelTable, ProjectTable, ToolTable, TopSessionsTable } from './UsageTables'

export function UsageView({ reservesWindowControls = true }: { reservesWindowControls?: boolean }) {
  const openChat = useViewStore((s) => s.openChat)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const s = useUsageStore()

  // Lands keyboard and screen-reader users on the view instead of the nav button just activated.
  useEffect(() => {
    headingRef.current?.focus()
    void useUsageStore.getState().open()
    return () => useUsageStore.getState().close()
  }, [])

  const status = s.status
  const [announcement, announce] = useClearedAnnouncement()
  const wasRunning = useRef(false)
  const running = status?.running === true
  const seen = status?.sessionsSeen ?? 0
  // The strip unmounts when counting ends, so the announcement lives here for the life of the view.
  useEffect(() => {
    if (wasRunning.current && !running && seen > 0) announce('Usage history counted')
    wasRunning.current = running
  }, [running, seen, announce])

  const nothingFound = status !== null && !status.running && (!status.found || status.sessionsSeen === 0)
  const showProgress = status !== null && (status.running || (status.sessionsSeen > 0 && status.sessionsDone < status.sessionsSeen))
  const pending = (empty: boolean): boolean => !s.loaded || (running && empty)
  const activeFilters = countActiveFilters(s.filters)
  const filteredEmpty = s.loaded && !running && activeFilters > 0 && s.summary !== null && s.summary.calls === 0
  return (
    <section aria-label="Usage" className="flex h-full flex-col overflow-hidden">
      <ScreenHeader
        title="Usage"
        headingRef={headingRef}
        backLabel="Back to chat"
        onBack={() => openChat()}
        reservesWindowControls={reservesWindowControls}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <UsageFilters />
      <div
        aria-busy={s.refreshing}
        className={`flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-4 transition-opacity ${s.refreshing ? 'opacity-60' : ''}`}
      >
        {showProgress && status && (
          <ProgressStrip
            value={status.sessionsDone}
            max={status.sessionsSeen}
            label={`${s.jokes ? 'Counting your sins' : 'Reading sessions'}: ${status.sessionsDone} of ${status.sessionsSeen} sessions`}
          />
        )}
        {s.error && <ScreenSection title="Usage figures" error={`Some figures could not be loaded: ${s.error}`} />}
        {nothingFound ? (
          <UsageEmptyState sessionsDir={status.sessionsDir} found={status.found} jokes={s.jokes} />
        ) : filteredEmpty ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No usage matches these filters.</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="ghost" onClick={clearUsageFilters}>
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <BudgetCard budget={s.budget} jokes={s.jokes} />
            <ScreenSection title="Overview" loading={!s.loaded || s.summary === null}>
              {s.summary && <HeadlineCards summary={s.summary} jokes={s.jokes} />}
            </ScreenSection>
            <AverageCards summary={s.summary} loading={!s.loaded || s.summary === null} />
            <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
              <SpendChart buckets={s.timeseries} bucket={s.bucket} onBucketChange={s.setBucket} loading={pending(s.timeseries.length === 0)} />
              <TokenMixChart rows={s.tokenMix} loading={pending(s.tokenMix.length === 0)} />
            </div>
            {s.jokes && s.frustration && <FrustrationCard frustration={s.frustration} />}
            <ProjectTable rows={s.byProject} loading={pending(s.byProject.length === 0)} />
            <ModelTable rows={s.byModel} loading={pending(s.byModel.length === 0)} />
            <ToolTable rows={s.byTool} loading={pending(s.byTool.length === 0)} />
            <TopSessionsTable rows={s.topSessions} loading={pending(s.topSessions.length === 0)} />
            <CallLogTable loading={pending(s.calls.rows.length === 0)} />
          </>
        )}
      </div>
    </section>
  )
}
