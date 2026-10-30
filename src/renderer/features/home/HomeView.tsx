// The Home view (#869, spec 059): shown at launch with no pane open, and from the nav's Home
// item. Needs you, Recent Sessions, My pull requests, My issues, Quick actions and Tidy up, with
// one Refresh for the GitHub sections. Nothing here polls.
import { useEffect, useRef, useState } from 'react'
import { RefreshButton } from '@/features/pull-requests/RefreshButton'
import { RelativeTime } from '@/components/relative-time'
import { ScreenHeader } from '@/components/ScreenHeader'
import { failedHomeSections, githubRepositoryIds, useHomeStore } from '@/state/home-store'
import { useRepositoriesStore, useViewStore } from '@/state'
import { MyIssuesSection, MyPullRequestsSection } from './HomeGitHubSections'
import { NeedsYouSection, RecentSessionsSection, useHomeSessions } from './HomeSessionSections'
import { QuickActionsSection } from './QuickActionsSection'
import { TidyUpSection } from './TidyUpSection'

export function HomeView({ reservesWindowControls = false }: { reservesWindowControls?: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const { needsYou, recent } = useHomeSessions()
  const loading = useHomeStore((state) => state.loading)
  const fetchedAt = useHomeStore((state) => state.fetchedAt)
  const refresh = useHomeStore((state) => state.refresh)
  const fetchedProjectKey = useHomeStore((state) => state.fetchedProjectKey)
  const openedFromNav = useViewStore((state) => state.view === 'home')
  const [announcement, setAnnouncement] = useState('')
  const projectKey = githubRepositoryIds(repositories).join(',')
  const hasGithubProjects = projectKey !== ''

  // At launch Home is just the empty screen, so focus moves to the heading only when the user
  // chose Home from the nav.
  useEffect(() => {
    if (openedFromNav) headingRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, [])

  // Fetches on first open and again when the set of GitHub Projects changes (for example the
  // Projects load after Home mounts); a refresh already running is retried once loading clears.
  useEffect(() => {
    if (!loading && fetchedProjectKey !== projectKey) void refresh(repositories)
  }, [loading, fetchedProjectKey, projectKey, repositories, refresh])

  async function handleRefresh(): Promise<void> {
    setAnnouncement('Refreshing Home')
    const ran = await refresh(repositories)
    if (!ran) {
      setAnnouncement('')
      return
    }
    const failed = failedHomeSections(useHomeStore.getState())
    setAnnouncement(failed.length > 0 ? `Refreshed with errors in ${failed.join(', ')}` : 'Refreshed')
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
          <QuickActionsSection />
          <TidyUpSection onAnnounce={setAnnouncement} />
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
