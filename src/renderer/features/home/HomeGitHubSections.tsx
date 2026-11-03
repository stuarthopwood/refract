// Home's My pull requests and My issues sections (#869). Both reuse the cross-Project queries
// (`pullRequests.listAcross`, #874; `issues.list`, #504) scoped to Projects with a GitHub remote;
// the data lives in the Home store and refreshes only on Home's Refresh.
import { useState } from 'react'
import { FilterTabs } from '@/components/FilterTabs'
import { ListCardButton } from '@/components/ListCardButton'
import { RelativeTime } from '@/components/relative-time'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { useHomeStore, type HomeIssueTab, type HomePrTab } from '@/state/home-store'
import { useIssuesStore, usePullRequestsStore, useViewStore } from '@/state'
import type { IssueSkippedProject } from '../../../shared/ipc-issues'

const PR_TABS: Array<{ value: HomePrTab; label: string }> = [
  { value: 'authored', label: 'Authored by me' },
  { value: 'review-requested', label: 'Review requested from me' }
]
const ISSUE_TABS: Array<{ value: HomeIssueTab; label: string }> = [
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'authored', label: 'Authored by me' }
]

function skippedNote(skipped: IssueSkippedProject[]): string | null {
  if (skipped.length === 0) return null
  return `${skipped.length} ${skipped.length === 1 ? 'Project was' : 'Projects were'} not listed.`
}

export function MyPullRequestsSection({ hasGithubProjects }: { hasGithubProjects: boolean }) {
  const [tab, setTab] = useState<HomePrTab>('authored')
  const section = useHomeStore((state) => state.prs[tab])
  const firstFetch = useHomeStore((state) => state.fetchedAt === null)
  const openPullRequest = usePullRequestsStore((state) => state.openPullRequest)
  const openPullRequests = useViewStore((state) => state.openPullRequests)
  return (
    <ScreenSection
      title="My pull requests"
      count={section.items.length}
      loading={firstFetch}
      empty={section.items.length === 0 ? (hasGithubProjects ? 'No open pull requests here.' : 'Add a Project with a GitHub remote to see pull requests.') : null}
      note={skippedNote(section.skipped)}
      error={section.error}
      actions={
        <>
          <FilterTabs<HomePrTab> value={tab} onValueChange={setTab} tabs={PR_TABS} ariaLabel="Pull request filter" />
          <Button type="button" variant="ghost" size="sm" onClick={openPullRequests} aria-label="Show all pull requests">
            Show all
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-1">
        {section.items.map((item) => (
          <li key={`${item.repositoryId}-${item.number}`}>
            <ListCardButton
              ariaLabel={`Open pull request ${item.number}, ${item.title}, ${item.repositoryName}, ${item.state.toLowerCase()}, updated ${formatRelativeTime(item.updatedAt)}`}
              onClick={() => {
                openPullRequest(item.repositoryId, item.number)
                openPullRequests()
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-medium">{item.title}</span>
                <RelativeTime value={item.updatedAt} focusable={false} className="ml-auto shrink-0 text-xs text-muted-foreground" />
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {item.repositoryName} · #{item.number} · {item.state.toLowerCase()}
              </span>
            </ListCardButton>
          </li>
        ))}
      </ul>
    </ScreenSection>
  )
}

export function MyIssuesSection({ hasGithubProjects }: { hasGithubProjects: boolean }) {
  const [tab, setTab] = useState<HomeIssueTab>('assigned')
  const section = useHomeStore((state) => state.issues[tab])
  const firstFetch = useHomeStore((state) => state.fetchedAt === null)
  const select = useIssuesStore((state) => state.select)
  const openIssues = useViewStore((state) => state.openIssues)
  return (
    <ScreenSection
      title="My issues"
      count={section.items.length}
      loading={firstFetch}
      empty={section.items.length === 0 ? (hasGithubProjects ? 'No open issues here.' : 'Add a Project with a GitHub remote to see issues.') : null}
      note={skippedNote(section.skipped)}
      error={section.error}
      actions={
        <>
          <FilterTabs<HomeIssueTab> value={tab} onValueChange={setTab} tabs={ISSUE_TABS} ariaLabel="Issue filter" />
          <Button type="button" variant="ghost" size="sm" onClick={openIssues} aria-label="Show all issues">
            Show all
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-1">
        {section.items.map((item) => (
          <li key={`${item.repositoryId}-${item.number}`}>
            <ListCardButton
              ariaLabel={`Open issue ${item.number}, ${item.title}, ${item.repositoryName}, updated ${formatRelativeTime(item.updatedAt)}`}
              onClick={() => {
                select({ repositoryId: item.repositoryId, number: item.number })
                openIssues()
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-medium">{item.title}</span>
                <RelativeTime value={item.updatedAt} focusable={false} className="ml-auto shrink-0 text-xs text-muted-foreground" />
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {item.repositoryName} · #{item.number}
              </span>
            </ListCardButton>
          </li>
        ))}
      </ul>
    </ScreenSection>
  )
}