// Spec 060 S2-14: the top-level Usage view (left nav, same shell as Pull requests and Issues).
// Ingest already runs from app launch; opening this re-asks for a start (idempotent) and leaving it
// only unsubscribes. The dashboard fills as data arrives, with a progress strip while the first
// backfill runs.
import { useEffect, useRef } from 'react'
import { ProgressStrip } from '@/components/ProgressStrip'
import { ScreenHeader } from '@/components/ScreenHeader'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { LoadingOverlay } from '@/components/ui/loading-overlay'
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
import { refreshAnnouncement } from './refreshAnnouncement'
import { ErrorCategoryTable, ModelTable, ProjectTable, ToolTable, TopSessionsTable } from './UsageTables'

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

  // Only a refresh of loaded figures announces; the first load shows section skeletons instead.
  const updating = s.refreshing && s.loaded
  const wasUpdating = useRef(false)
  useEffect(() => {
    const text = refreshAnnouncement(wasUpdating.current, updating)
    if (text) announce(text)
    wasUpdating.current = updating
  }, [updating, announce])

  // Null status is the first paint before start() answers; a dashboard skeleton there flashes then swaps.
  // A failed start leaves it null, so that case falls through to the error section.
  const scanPending = status === null ? s.error === null : !status.scanCompleted
  const nothingFound = status !== null && !scanPending && !status.running && (!status.found || status.sessionsSeen === 0)
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
      {/* The overlay sits inside the scroll container so its sticky card stays in view while the stats scroll. First load keeps the section skeletons, so only a refresh of loaded figures blurs. It stays interactive so a bucket, sort or page control keeps focus; this wrapper owns `aria-busy`. */}
      <div aria-busy={s.refreshing} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <LoadingOverlay
          loading={updating}
          inertWhileLoading={false}
          className="flex flex-1 flex-col"
          contentClassName="flex flex-1 flex-col gap-8"
        >
          {showProgress && status && (
            <ProgressStrip
              value={status.sessionsDone}
              max={status.sessionsSeen}
              label={`${s.jokes ? 'Counting your sins' : 'Reading sessions'}: ${status.sessionsDone} of ${status.sessionsSeen} sessions`}
            />
          )}
          {s.error && <ScreenSection title="Usage figures" error={`Some figures could not be loaded: ${s.error}`} />}
          {scanPending ? (
            <ScreenSection title="Usage figures" loading busy />
          ) : nothingFound ? (
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
              <ErrorCategoryTable rows={s.errorCategories} loading={pending(false)} />
              <TopSessionsTable rows={s.topSessions} loading={pending(s.topSessions.length === 0)} />
              <CallLogTable loading={pending(s.calls.rows.length === 0)} />
            </>
          )}
        </LoadingOverlay>
      </div>
    </section>
  )
}
