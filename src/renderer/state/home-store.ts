// Home view data (#869, spec 059). Caches the GitHub sections and the Tidy-up list for the app's
// life; one Refresh refetches all of them and nothing polls. Every call is scoped to the added
// Projects that have a GitHub remote, so no unscoped `gh` search ever runs.
import { create } from 'zustand'
import type { IssueListItem, IssueSkippedProject, IssueTab } from '../../shared/ipc-issues'
import type { PullRequestAcrossItem } from '../../shared/ipc-pull-requests'
import type { ClosedBranchItem } from '../../shared/ipc-home'
import { HOME_LAST_MESSAGES_MAX } from '../../shared/ipc-home'
import type { Repository } from '../../shared/model'

export type HomePrTab = 'authored' | 'review-requested'
export const HOME_SECTION_LIMIT = 10
const PR_FETCH_LIMIT = 50
const MAX_PROJECTS = 40

export interface HomeSection<T> {
  items: T[]
  skipped: IssueSkippedProject[]
  error: string | null
}

const EMPTY = <T,>(): HomeSection<T> => ({ items: [], skipped: [], error: null })

interface HomeState {
  prs: Record<HomePrTab, HomeSection<PullRequestAcrossItem>>
  issues: Record<'assigned' | 'authored', HomeSection<IssueListItem>>
  closed: HomeSection<ClosedBranchItem>
  lastMessages: Record<string, string | null>
  fetchedAt: string | null
  loading: boolean
  refresh(repositories: Repository[], recentSessionIds: string[]): Promise<void>
  loadLastMessages(sessionIds: string[]): Promise<void>
}

/** Projects with a GitHub remote, the only ones any GitHub call may name. */
export function githubRepositoryIds(repositories: Repository[]): string[] {
  return repositories
    .filter((repository) => repository.remote?.kind === 'has' && repository.remote.host === 'github.com')
    .slice(0, MAX_PROJECTS)
    .map((repository) => repository.id)
}

export const useHomeStore = create<HomeState>((set, get) => ({
  prs: { authored: EMPTY(), 'review-requested': EMPTY() },
  issues: { assigned: EMPTY(), authored: EMPTY() },
  closed: EMPTY(),
  lastMessages: {},
  fetchedAt: null,
  loading: false,
  async loadLastMessages(sessionIds) {
    const ids = sessionIds.slice(0, HOME_LAST_MESSAGES_MAX)
    if (ids.length === 0) return
    const result = await window.refract.home.lastMessages(ids)
    if (result.ok) set({ lastMessages: { ...get().lastMessages, ...result.value } })
  },
  async refresh(repositories, recentSessionIds) {
    if (get().loading) return
    set({ loading: true })
    const ids = githubRepositoryIds(repositories)
    const api = window.refract
    const noProjects = ids.length === 0
    const prTabs: HomePrTab[] = ['authored', 'review-requested']
    const issueTabs: Array<'assigned' | 'authored'> = ['assigned', 'authored']
    const [prResults, issueResults, closedResult] = await Promise.all([
      Promise.all(prTabs.map((tab) => (noProjects ? null : api.pullRequests.listAcross(tab, 'open', ids, '', PR_FETCH_LIMIT)))),
      Promise.all(issueTabs.map((tab: IssueTab) => (noProjects ? null : api.issues.list(tab, 'open', ids, null, '')))),
      noProjects ? null : api.home.closedBranches(ids),
      get().loadLastMessages(recentSessionIds)
    ])
    const prs = { ...get().prs }
    prTabs.forEach((tab, index) => {
      const result = prResults[index]
      if (!result) prs[tab] = EMPTY()
      else if (result.ok) prs[tab] = { items: result.value.items.slice(0, HOME_SECTION_LIMIT), skipped: result.value.skipped, error: null }
      else prs[tab] = { ...prs[tab], error: result.error.message }
    })
    const issues = { ...get().issues }
    issueTabs.forEach((tab, index) => {
      const result = issueResults[index]
      if (!result) issues[tab] = EMPTY()
      else if (result.ok) issues[tab] = { items: result.value.issues.slice(0, HOME_SECTION_LIMIT), skipped: result.value.skipped, error: null }
      else issues[tab] = { ...issues[tab], error: result.error.message }
    })
    const closed = !closedResult
      ? EMPTY<ClosedBranchItem>()
      : closedResult.ok
        ? { items: closedResult.value.items, skipped: closedResult.value.skipped, error: null }
        : { ...get().closed, error: closedResult.error.message }
    set({ prs, issues, closed, fetchedAt: new Date().toISOString(), loading: false })
  }
}))
