// Spec 060 S2-14: the top-level Usage view (left nav, same shell as Pull requests and Issues).
// Opening it starts the backfill and the rescan; leaving it stops the rescan. The dashboard fills
// as data arrives, with a progress strip while the first backfill runs.
import { useEffect, useRef } from 'react'
import { ProgressStrip } from '@/components/ProgressStrip'
import { ScreenHeader } from '@/components/ScreenHeader'
import { ScreenSection } from '@/components/ScreenSection'
import { useUsageStore } from '@/state/usage-store'
import { useViewStore } from '@/state'
import { BudgetCard } from './BudgetCard'
import { CallLogTable } from './CallLogTable'
import { FrustrationCard } from './FrustrationCard'
import { HeadlineCards } from './HeadlineCards'
import { SpendChart } from './SpendChart'
import { TokenMixChart } from './TokenMixChart'
import { UsageEmptyState } from './UsageEmptyState'
import { UsageFilters } from './UsageFilters'
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
  const nothingFound = status !== null && !status.running && (!status.found || status.sessionsSeen === 0)
  const showProgress = status !== null && (status.running || (status.sessionsSeen > 0 && status.sessionsDone < status.sessionsSeen))
  return (
    <section aria-label="Usage" className="flex h-full flex-col overflow-hidden">
      <ScreenHeader
        title="Usage"
        headingRef={headingRef}
        backLabel="Back to chat"
        onBack={() => openChat()}
        reservesWindowControls={reservesWindowControls}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <UsageFilters />
        {showProgress && status && (
          <ProgressStrip
            value={status.sessionsDone}
            max={status.sessionsSeen}
            label={`${s.jokes ? 'Counting your sins' : 'Reading sessions'}: ${status.sessionsDone} of ${status.sessionsSeen} sessions`}
            doneText="Finished counting. The dashboard is up to date."
          />
        )}
        {s.error && <p className="text-xs text-muted-foreground">Some figures could not be loaded: {s.error}</p>}
        {nothingFound ? (
          <UsageEmptyState sessionsDir={status.sessionsDir} found={status.found} jokes={s.jokes} />
        ) : (
          <>
            <BudgetCard budget={s.budget} jokes={s.jokes} />
            <ScreenSection title="Overview" loading={!s.loaded || s.summary === null}>
              {s.summary && <HeadlineCards summary={s.summary} jokes={s.jokes} />}
            </ScreenSection>
            <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
              <SpendChart buckets={s.timeseries} bucket={s.bucket} onBucketChange={s.setBucket} />
              <TokenMixChart rows={s.tokenMix} />
            </div>
            {s.jokes && s.frustration && <FrustrationCard frustration={s.frustration} />}
            <ProjectTable rows={s.byProject} />
            <ModelTable rows={s.byModel} />
            <ToolTable rows={s.byTool} />
            <TopSessionsTable rows={s.topSessions} />
            <CallLogTable />
          </>
        )}
      </div>
    </section>
  )
}
