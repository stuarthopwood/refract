// Pull requests view state (issue #874, spec 057): one cross-Project list, so a flat store like
// `issues-store.ts` rather than per-repository slices. Fetches on open, on a filter change, on
// explicit Refresh and on "Show more" only, never on a timer; a `github:changed` write adds one
// quiet refetch (#1589). A separate cross-Project "active
// count" slice (issue #569) feeds the sidebar badge and is independent of the list.
import { create } from 'zustand'
import { selectionAfterRefresh } from './selection-handoff'
import type { IpcError, Result } from '../../shared/ipc'
import type { FilterTab, PullRequestStateFilter } from '../../shared/github'
import type { IssueSkippedProject } from '../../shared/ipc-issues'
import { HOME_PROJECTS_MAX } from '../../shared/ipc-home'
import type { PullRequestAcrossItem } from '../../shared/ipc-pull-requests'

export const PAGE_SIZE = 50
export const MAX_ROWS = 200
/** The smallest page the list IPC accepts; the badge shows "30+" from 30 rows. */
export const ACTIVE_COUNT_LIMIT = 50
/** From this many rows the badge reads "30+". */
export const ACTIVE_COUNT_CAP_AT = 30

export interface PullRequestsActiveCount {
  count: number | null
  /** More Projects than one call covers, or some Projects were skipped: the count is a lower bound. */
  partial: boolean
  loading: boolean
  fetchedAt: string | null
}

function emptyActiveCount(): PullRequestsActiveCount {
  return { count: null, partial: false, loading: false, fetchedAt: null }
}

const EMPTY_PULL_REQUESTS_ACTIVE_COUNT: PullRequestsActiveCount = emptyActiveCount()

/** Whether the list's own search is the badge's search, so one fetch can serve both. */
export function sharesActiveCountSearch(
  s: { tab: FilterTab; state: PullRequestStateFilter; repositoryIds: string[]; query: string; limit: number },
  allRepositoryIds: string[]
): boolean {
  return (
    s.tab === 'all' &&
    s.state === 'open' &&
    s.repositoryIds.length === 0 &&
    s.query.trim() === '' &&
    s.limit === ACTIVE_COUNT_LIMIT &&
    allRepositoryIds.length <= HOME_PROJECTS_MAX
  )
}

export interface SelectedPullRequest {
  repositoryId: string
  number: number
}

interface PullRequestsState {
  tab: FilterTab
  state: PullRequestStateFilter
  /** Chosen Project ids; empty means every Project. */
  repositoryIds: string[]
  /** The still-typed search text; applies on Enter, copied to `appliedQuery` by `refresh()`. */
  query: string
  appliedQuery: string
  items: PullRequestAcrossItem[]
  skipped: IssueSkippedProject[]
  hasMore: boolean
  /** Rows asked for, 50 to 200; "Show more" raises it by 50. */
  limit: number
  fetchedAt: string | null
  loading: boolean
  error: IpcError | null
  selected: SelectedPullRequest | null
  setTab(tab: FilterTab): void
  setState(state: PullRequestStateFilter): void
  setRepositoryIds(ids: string[]): void
  setQuery(query: string): void
  clearFilters(): void
  select(selected: SelectedPullRequest | null): void
  /** Home and chat readouts: show one pull request, with its Project the only one listed. */
  openPullRequest(repositoryId: string, number: number): void
  /** `allRepositoryIds` is every added Project, used when no Project is chosen. */
  refresh(allRepositoryIds: string[], more?: boolean): Promise<void>
  /** Background refetch with the applied filters after a `github:changed` write: no loading or error state, old rows kept on failure, selection moves on if its row is gone. */
  refreshQuiet(allRepositoryIds: string[]): Promise<void>
  loadMore(allRepositoryIds: string[]): Promise<void>
  /** The sidebar badge: open pull requests across every added Project, the set the view lists by default. */
  activeCount: PullRequestsActiveCount
  /** Never polled; callers are the sidebar mount effect, the window focus refresh, the account-change refetch, the list's Refresh and `github:changed`. */
  refreshActiveCount(allRepositoryIds: string[]): Promise<void>
  /** The active GitHub account changed: the cached count is stale. */
  clearActiveCounts(): void
}

let refreshSequence = 0
// So a stale count fetch never overwrites a newer one.
let activeCountSequence = 0
// Callers racing at startup (account load, sidebar mount) share one in-flight fetch per Project set.
let activeCountInFlight: { key: string; promise: Promise<void> } | null = null

function activeCountFrom(
  value: { items: PullRequestAcrossItem[]; skipped?: IssueSkippedProject[]; fetchedAt: string },
  projectCount: number
): PullRequestsActiveCount {
  return {
    count: value.items.length,
    partial: projectCount > HOME_PROJECTS_MAX || (value.skipped?.length ?? 0) > 0,
    loading: false,
    fetchedAt: value.fetchedAt
  }
}

export const usePullRequestsStore = create<PullRequestsState>((set, get) => ({
  tab: 'all',
  state: 'open',
  repositoryIds: [],
  query: '',
  appliedQuery: '',
  items: [],
  skipped: [],
  hasMore: false,
  limit: PAGE_SIZE,
  fetchedAt: null,
  loading: false,
  error: null,
  selected: null,
  // A filter change drops the selection and the paging so the detail pane never shows a pull
  // request the list no longer has.
  setTab: (tab) => set({ tab, selected: null, limit: PAGE_SIZE }),
  setState: (state) => set({ state, selected: null, limit: PAGE_SIZE }),
  setRepositoryIds: (repositoryIds) => set({ repositoryIds, selected: null, limit: PAGE_SIZE }),
  setQuery: (query) => set({ query }),
  // A fresh `repositoryIds` array on every reset is what re-runs the list's fetch effect, so Clear
  // filters refetches even when only the search was active.
  clearFilters: () =>
    set({ state: 'open', repositoryIds: [], query: '', appliedQuery: '', selected: null, limit: PAGE_SIZE }),
  select: (selected) => set({ selected }),
  openPullRequest: (repositoryId, number) =>
    set({
      tab: 'all',
      state: 'all',
      repositoryIds: [repositoryId],
      query: '',
      appliedQuery: '',
      limit: PAGE_SIZE,
      selected: { repositoryId, number }
    }),
  async refresh(allRepositoryIds, more = false) {
    const { tab, state, repositoryIds } = get()
    const ids = repositoryIds.length > 0 ? repositoryIds.filter((id) => allRepositoryIds.includes(id)) : allRepositoryIds
    // "Show more" keeps the applied search and takes the next page; it only commits the new limit
    // once the rows arrive, so the button stays mounted (and focused) while loading.
    const query = more ? get().appliedQuery : get().query
    const changedSearch = !more && query.trim() !== get().appliedQuery.trim()
    const limit = more
      ? Math.min(get().limit + PAGE_SIZE, MAX_ROWS)
      : changedSearch
        ? PAGE_SIZE
        : get().limit
    refreshSequence += 1
    const sequence = refreshSequence
    set(more ? { loading: true, error: null } : { loading: true, error: null, appliedQuery: query, limit })
    let result: Result<{ items: PullRequestAcrossItem[]; hasMore: boolean; skipped: IssueSkippedProject[]; fetchedAt: string }>
    try {
      result = await window.refract.pullRequests.listAcross(tab, state, ids, query.trim(), limit)
    } catch {
      if (sequence !== refreshSequence) return
      const error = { code: 'gh-failed' as const, message: 'Could not list pull requests.' }
      set(more ? { loading: false, error } : { loading: false, error, items: [], skipped: [], hasMore: false })
      return
    }
    // A newer refresh superseded this one; dropping the stale response keeps the list coherent.
    if (sequence !== refreshSequence) return
    if (!result.ok) {
      if (!more && sharesActiveCountSearch({ tab, state, repositoryIds, query, limit }, allRepositoryIds)) {
        activeCountSequence += 1
        activeCountInFlight = null
        set({ activeCount: emptyActiveCount() })
      }
      set(
        more
          ? { loading: false, error: result.error }
          : { loading: false, error: result.error, items: [], skipped: [], hasMore: false }
      )
      return
    }
    set({
      loading: false,
      limit,
      items: result.value.items,
      skipped: result.value.skipped,
      hasMore: result.value.hasMore,
      fetchedAt: result.value.fetchedAt
    })
    // On default filters this search is the badge's search; reuse it and drop any badge fetch in flight.
    if (!more && sharesActiveCountSearch({ tab, state, repositoryIds, query, limit }, allRepositoryIds)) {
      activeCountSequence += 1
      activeCountInFlight = null
      set({ activeCount: activeCountFrom(result.value, allRepositoryIds.length) })
    }
  },
  async refreshQuiet(allRepositoryIds) {
    const { tab, state, repositoryIds, appliedQuery, limit } = get()
    const ids = repositoryIds.length > 0 ? repositoryIds.filter((id) => allRepositoryIds.includes(id)) : allRepositoryIds
    const sequence = refreshSequence
    let result: Result<{ items: PullRequestAcrossItem[]; hasMore: boolean; skipped: IssueSkippedProject[]; fetchedAt: string }>
    try {
      result = await window.refract.pullRequests.listAcross(tab, state, ids, appliedQuery.trim(), limit)
    } catch {
      return
    }
    // A user-driven refresh or filter change started meanwhile; it owns the list now.
    if (sequence !== refreshSequence || !result.ok) return
    const { items: previous, selected } = get()
    set({
      items: result.value.items,
      skipped: result.value.skipped,
      hasMore: result.value.hasMore,
      fetchedAt: result.value.fetchedAt,
      selected: selectionAfterRefresh(
        previous,
        result.value.items,
        selected,
        (item, s) => item.repositoryId === s.repositoryId && item.number === s.number,
        (item) => ({ repositoryId: item.repositoryId, number: item.number })
      )
    })
    if (sharesActiveCountSearch({ tab, state, repositoryIds, query: appliedQuery, limit }, allRepositoryIds)) {
      activeCountSequence += 1
      activeCountInFlight = null
      set({ activeCount: activeCountFrom(result.value, allRepositoryIds.length) })
    }
  },
  loadMore: (allRepositoryIds) => get().refresh(allRepositoryIds, true),
  activeCount: EMPTY_PULL_REQUESTS_ACTIVE_COUNT,
  refreshActiveCount: (allRepositoryIds) => {
    const key = allRepositoryIds.join('|')
    if (activeCountInFlight?.key === key) return activeCountInFlight.promise
    activeCountSequence += 1
    const sequence = activeCountSequence
    set({ activeCount: { ...get().activeCount, loading: true } })
    const promise = (async () => {
      // A rejected IPC call must not leave `loading: true` stuck, which would silently disable the
      // window-focus refresh and the mount effect (both skip while loading).
      let result: Result<{ items: PullRequestAcrossItem[]; skipped: IssueSkippedProject[]; fetchedAt: string }>
      try {
        result = await window.refract.pullRequests.listAcross('all', 'open', allRepositoryIds.slice(0, HOME_PROJECTS_MAX), '', ACTIVE_COUNT_LIMIT)
      } catch {
        if (activeCountSequence === sequence) set({ activeCount: emptyActiveCount() })
        return
      } finally {
        if (activeCountInFlight?.key === key && activeCountSequence === sequence) activeCountInFlight = null
      }
      if (activeCountSequence !== sequence) return
      // A failed fetch clears to `null` (renders as nothing), never a stale number.
      set({ activeCount: result.ok ? activeCountFrom(result.value, allRepositoryIds.length) : emptyActiveCount() })
    })()
    activeCountInFlight = { key, promise }
    return promise
  },
  clearActiveCounts: () => {
    activeCountSequence += 1
    activeCountInFlight = null
    set({ activeCount: EMPTY_PULL_REQUESTS_ACTIVE_COUNT })
  }
}))
