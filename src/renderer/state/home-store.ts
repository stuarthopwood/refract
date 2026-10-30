// Home view data (#869, spec 059). Caches the GitHub sections and the Tidy-up list for the app's
// life; one Refresh refetches all of them and nothing polls. Every call is scoped to the added
// Projects that have a GitHub remote, so no unscoped `gh` search ever runs.
import { create } from 'zustand'
import type { IssueListItem, IssueSkippedProject, IssueTab } from '../../shared/ipc-issues'
import type { PullRequestAcrossItem } from '../../shared/ipc-pull-requests'
import type { ClosedBranchItem } from '../../shared/ipc-home'
import { HOME_LAST_MESSAGES_MAX, HOME_PROJECTS_MAX } from '../../shared/ipc-home'
import type { Result } from '../../shared/ipc'
import type { Repository } from '../../shared/model'

export type HomePrTab = 'authored' | 'review-requested'
export type HomeIssueTab = Extract<IssueTab, 'assigned' | 'authored'>
export const HOME_SECTION_LIMIT = 10
const PR_FETCH_LIMIT = 50
const PR_TABS: HomePrTab[] = ['authored', 'review-requested']
const ISSUE_TABS: HomeIssueTab[] = ['assigned', 'authored']

export interface HomeSection<T> {
  items: T[]
  skipped: IssueSkippedProject[]
  error: string | null
}

const EMPTY = <T,>(): HomeSection<T> => ({ items: [], skipped: [], error: null })

interface HomeState {
  prs: Record<HomePrTab, HomeSection<PullRequestAcrossItem>>
  issues: Record<HomeIssueTab, HomeSection<IssueListItem>>
  closed: HomeSection<ClosedBranchItem>
  lastMessages: Record<string, string | null>
  fetchedAt: string | null
  /** The Project ids the last fetch was scoped to; Home refetches when the set changes. */
  fetchedProjectKey: string | null
  loading: boolean
  /** Resolves false when a refresh was already running and this call did nothing. */
  refresh(repositories: Repository[]): Promise<boolean>
  loadLastMessages(sessionIds: string[]): Promise<void>
}

/** Projects with a GitHub remote, the only ones any GitHub call may name. */
export function githubRepositoryIds(repositories: Repository[]): string[] {
  return repositories
    .filter((repository) => repository.remote?.kind === 'has' && repository.remote.host === 'github.com')
    .slice(0, HOME_PROJECTS_MAX)
    .map((repository) => repository.id)
}

/** Sections that currently hold an error, by display name, for the Refresh announcement. */
export function failedHomeSections(state: Pick<HomeState, 'prs' | 'issues' | 'closed'>): string[] {
  const failed: string[] = []
  if (state.prs.authored.error || state.prs['review-requested'].error) failed.push('My pull requests')
  if (state.issues.assigned.error || state.issues.authored.error) failed.push('My issues')
  if (state.closed.error) failed.push('Tidy up')
  return failed
}

type Settled<T> = PromiseSettledResult<Result<T>> | null

/** Folds a settled IPC call into a section: ok replaces it, a failure keeps the old items and sets the error. */
function toSection<T, U>(settled: Settled<T>, previous: HomeSection<U>, map: (value: T) => Omit<HomeSection<U>, 'error'>): HomeSection<U> {
  if (!settled) return EMPTY()
  if (settled.status === 'rejected') return { ...previous, error: settled.reason instanceof Error ? settled.reason.message : 'Request failed' }
  if (!settled.value.ok) return { ...previous, error: settled.value.error.message }
  return { ...map(settled.value.value), error: null }
}

/** `allSettled` wraps the `null` "no Projects, no call" placeholders as fulfilled nulls; unwrap them. */
function unwrap<T>(entry: PromiseSettledResult<Result<T> | null>): Settled<T> {
  return entry.status === 'fulfilled' && entry.value === null ? null : (entry as PromiseSettledResult<Result<T>>)
}

export const useHomeStore = create<HomeState>((set, get) => ({
  prs: { authored: EMPTY(), 'review-requested': EMPTY() },
  issues: { assigned: EMPTY(), authored: EMPTY() },
  closed: EMPTY(),
  lastMessages: {},
  fetchedAt: null,
  fetchedProjectKey: null,
  loading: false,
  async loadLastMessages(sessionIds) {
    const ids = sessionIds.slice(0, HOME_LAST_MESSAGES_MAX)
    if (ids.length === 0) return
    try {
      const result = await window.refract.home.lastMessages(ids)
      if (result.ok) set({ lastMessages: { ...get().lastMessages, ...result.value } })
    } catch {
      // A missing one-line preview is not worth a visible error.
    }
  },
  async refresh(repositories) {
    if (get().loading) return false
    set({ loading: true })
    try {
      const ids = githubRepositoryIds(repositories)
      const api = window.refract
      const noProjects = ids.length === 0
      const [prSettled, issueSettled, closedSettled] = await Promise.all([
        Promise.allSettled(PR_TABS.map((tab) => (noProjects ? null : api.pullRequests.listAcross(tab, 'open', ids, '', PR_FETCH_LIMIT)))),
        Promise.allSettled(ISSUE_TABS.map((tab) => (noProjects ? null : api.issues.list(tab, 'open', ids, null, '')))),
        Promise.allSettled([noProjects ? null : api.home.closedBranches(ids)])
      ])
      const { prs: previousPrs, issues: previousIssues, closed: previousClosed } = get()
      const prs = { ...previousPrs }
      PR_TABS.forEach((tab, index) => {
        prs[tab] = toSection(unwrap(prSettled[index]), previousPrs[tab], (value) => ({ items: value.items.slice(0, HOME_SECTION_LIMIT), skipped: value.skipped }))
      })
      const issues = { ...previousIssues }
      ISSUE_TABS.forEach((tab, index) => {
        issues[tab] = toSection(unwrap(issueSettled[index]), previousIssues[tab], (value) => ({ items: value.issues.slice(0, HOME_SECTION_LIMIT), skipped: value.skipped }))
      })
      const closed = toSection(unwrap(closedSettled[0]), previousClosed, (value) => ({ items: value.items, skipped: value.skipped }))
      set({ prs, issues, closed, fetchedAt: new Date().toISOString(), fetchedProjectKey: ids.join(',') })
      return true
    } finally {
      set({ loading: false })
    }
  }
}))
