// The Home view (#869, spec 059): shown at launch with no pane open, and from the nav's Home
// item. Needs you, Recent Sessions, My pull requests, My issues, Tidy up and Quick actions, with
// one Refresh for the GitHub sections. Nothing here polls.
import { useEffect, useRef, useState } from 'react'
import { RefreshButton } from '@/features/pull-requests/RefreshButton'
import { RelativeTime } from '@/components/relative-time'
import { ScreenHeader } from '@/components/ScreenHeader'
import { useHomeStore } from '@/state/home-store'
import { useRepositoriesStore } from '@/state'
import { MyIssuesSection, MyPullRequestsSection } from './HomeGitHubSections'
import { NeedsYouSection, RecentSessionsSection, useHomeSessions } from './HomeSessionSections'
import { QuickActionsSection } from './QuickActionsSection'
import { TidyUpSection } from './TidyUpSection'
import { githubRepositoryIds } from '@/state/home-store'

export function HomeView({ reservesWindowControls = false }: { reservesWindowControls?: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const { needsYou, recent } = useHomeSessions()
  const loading = useHomeStore((state) => state.loading)
  const fetchedAt = useHomeStore((state) => state.fetchedAt)
  const refresh = useHomeStore((state) => state.refresh)
  const [announcement, setAnnouncement] = useState('')
  const hasGithubProjects = githubRepositoryIds(repositories).length > 0
  const recentKey = recent.map((session) => session.id).join(',')

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // First open per app life fetches once; later opens show the cache until Refresh.
  useEffect(() => {
    if (useHomeStore.getState().fetchedAt === null) void refresh(repositories, recentKey ? recentKey.split(',') : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGithubProjects])

  async function handleRefresh(): Promise<void> {
    setAnnouncement('Refreshing Home')
    await refresh(repositories, recentKey ? recentKey.split(',') : [])
    const state = useHomeStore.getState()
    const failed = [...Object.values(state.prs), ...Object.values(state.issues), state.closed].some((section) => section.error)
    setAnnouncement(failed ? 'Refreshed with errors' : 'Refreshed')
  }

  return (
    <div role="region" aria-label="Home" className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="Home" headingRef={headingRef} reservesWindowControls={reservesWindowControls}>
        {fetchedAt && (
          <span className="text-xs text-muted-foreground">
            Updated <RelativeTime value={fetchedAt} />
          </span>
        )}
        <RefreshButton loading={loading} onClick={() => void handleRefresh()} label="Refresh Home" />
      </ScreenHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-4">
          <NeedsYouSection sessions={needsYou} />
          <RecentSessionsSection sessions={recent} />
          <MyPullRequestsSection hasGithubProjects={hasGithubProjects} />
          <MyIssuesSection hasGithubProjects={hasGithubProjects} />
          <TidyUpSection />
          <QuickActionsSection />
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
