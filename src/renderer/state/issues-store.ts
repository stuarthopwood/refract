// Issues view state (issue #504, spec 051): one cross-Project list, so a single store rather than
// the Pull requests store's per-repository slices. Fetches on open and on explicit Refresh or a
// filter change only, never on a timer; a `github:changed` write adds one quiet refetch (#1589).
import { create } from 'zustand'
import { selectionAfterRefresh } from './selection-handoff'
import type { QuietRefreshOutcome } from './pull-requests-store'
import { effectiveFilterQuery } from '@/components/filterQueryRule'
import type { IpcError, Result } from '../../shared/ipc'
import type { IssueListItem, IssueListResult, IssueSkippedProject, IssueStateFilter, IssueTab } from '../../shared/ipc-issues'
import { effectiveProjectIds, isDefaultOpenList, isFresh, listKey, type ListFreshness } from './list-freshness'

interface IssuesState {
  tab: IssueTab
  state: IssueStateFilter
  /** Chosen Project ids; empty means every Project. */
  repositoryIds: string[]
  /** Chosen label names, matched any-of; empty means no label filter. */
  labels: string[]
  /** The still-typed search text; applies on Enter, copied to `appliedQuery` by `refresh()`. */
  query: string
  appliedQuery: string
  items: IssueListItem[]
  skipped: IssueSkippedProject[]
  fetchedAt: string | null
  /** What the held rows were fetched for and when, so a remount can skip a fresh list (FR-180). */
  freshness: ListFreshness | null
  /** The held rows came from the on-disk List cache and no fresh fetch has replaced them yet (FR-181 (c)). */
  stale: boolean
  loading: boolean
  error: IpcError | null
  selected: { repositoryId: string; number: number } | null
  setTab(tab: IssueTab): void
  setState(state: IssueStateFilter): void
  setRepositoryIds(ids: string[]): void
  setLabels(labels: string[]): void
  removeLabel(label: string): void
  setQuery(query: string): void
  clearFilters(): void
  select(selected: { repositoryId: string; number: number } | null): void
  /** `allRepositoryIds` is every added Project, used when no Project is chosen. `submittedOnly` refetches with the applied search, leaving half-typed text unapplied. */
  refresh(allRepositoryIds: string[], submittedOnly?: boolean): Promise<void>
  /** The list's mount and filter-change fetch: no call while the held rows are fresh for the current filters (FR-180). */
  refreshIfStale(allRepositoryIds: string[]): Promise<void>
  /** Forgets freshness so the next mount fetches (the active account changed). */
  invalidateFreshness(): void
  /** Shows the on-disk List cache's default open list at once, marked stale; ignored once the list has rows, is loading or has left its defaults. */
  hydrateFromCache(cached: IssueListResult): void
  /** Background refetch with the applied filters after a `github:changed` write: no loading or error state, old rows kept on failure, selection moves on if its row is gone. */
  refreshQuiet(allRepositoryIds: string[]): Promise<QuietRefreshOutcome>
}

let refreshSequence = 0
// A mount and an idle prefetch asking for the same list share one fetch.
let refreshInFlight: { key: string; promise: Promise<void> } | null = null

export const useIssuesStore = create<IssuesState>((set, get) => ({
  tab: 'all',
  state: 'open',
  repositoryIds: [],
  labels: [],
  query: '',
  appliedQuery: '',
  items: [],
  skipped: [],
  fetchedAt: null,
  freshness: null,
  stale: false,
  loading: false,
  error: null,
  selected: null,
  // A filter change drops the selection so the detail pane never shows an issue the list no longer has.
  setTab: (tab) => set({ tab, selected: null, stale: false }),
  setState: (state) => set({ state, selected: null, stale: false }),
  setRepositoryIds: (repositoryIds) => set({ repositoryIds, selected: null, stale: false }),
  setLabels: (labels) => set({ labels, selected: null, stale: false }),
  removeLabel: (label) => set((s) => ({ labels: s.labels.filter((l) => l !== label), selected: null, stale: false })),
  setQuery: (query) => set({ query }),
  // A fresh `repositoryIds` array on every reset is what re-runs the list's fetch effect, so Clear
  // filters refetches even when only the search was active.
  clearFilters: () =>
    set({ state: 'open', repositoryIds: [], labels: [], query: '', appliedQuery: '', selected: null, stale: false }),
  select: (selected) => set({ selected }),
  hydrateFromCache(cached) {
    const current = get()
    if (
      current.loading ||
      current.error !== null ||
      current.fetchedAt !== null ||
      current.items.length > 0 ||
      cached.issues.length === 0
    )
      return
    if (!isDefaultOpenList(current)) return
    set({ items: cached.issues, skipped: cached.skipped, fetchedAt: cached.fetchedAt, stale: true })
  },
  refreshIfStale(allRepositoryIds) {
    const { tab, state, repositoryIds, labels, query, freshness } = get()
    const projectIds = effectiveProjectIds(repositoryIds, allRepositoryIds)
    // `refresh` applies the typed text, so a half-typed search is a changed key, never a stale hit.
    const key = listKey({ tab, state, projectIds, query: effectiveFilterQuery(query), labels })
    if (isFresh(freshness, key)) return Promise.resolve()
    if (refreshInFlight?.key === key) return refreshInFlight.promise
    const promise = get()
      .refresh(allRepositoryIds)
      .finally(() => {
        if (refreshInFlight?.promise === promise) refreshInFlight = null
      })
    refreshInFlight = { key, promise }
    return promise
  },
  // Bumping the sequence drops an old-account refresh still in flight, so it never stamps freshness or rows.
  invalidateFreshness: () => {
    refreshSequence += 1
    refreshInFlight = null
    set({ freshness: null, loading: false })
  },
  async refresh(allRepositoryIds, submittedOnly = false) {
    const { tab, state, repositoryIds, labels } = get()
    const query = submittedOnly ? get().appliedQuery : effectiveFilterQuery(get().query)
    const ids = repositoryIds.length > 0 ? repositoryIds.filter((id) => allRepositoryIds.includes(id)) : allRepositoryIds
    refreshSequence += 1
    const sequence = refreshSequence
    set({ loading: true, error: null, appliedQuery: query })
    const result = await window.refract.issues.list(tab, state, ids, labels, query.trim())
    // A newer refresh superseded this one; dropping the stale response keeps the list coherent.
    if (sequence !== refreshSequence) return
    if (!result.ok) {
      set({ loading: false, error: result.error, items: [], skipped: [], freshness: null, stale: false })
      return
    }
    set({
      loading: false,
      stale: false,
      items: result.value.issues,
      skipped: result.value.skipped,
      fetchedAt: result.value.fetchedAt,
      freshness: { key: listKey({ tab, state, projectIds: ids, query, labels }), atMs: Date.now() }
    })
  },
  async refreshQuiet(allRepositoryIds) {
    // A user fetch in flight owns the list; the caller reruns once it lands.
    if (get().loading) return 'deferred'
    const { tab, state, repositoryIds, labels, appliedQuery } = get()
    const ids = repositoryIds.length > 0 ? repositoryIds.filter((id) => allRepositoryIds.includes(id)) : allRepositoryIds
    refreshSequence += 1
    const sequence = refreshSequence
    let result: Result<IssueListResult>
    try {
      result = await window.refract.issues.list(tab, state, ids, labels, appliedQuery.trim())
    } catch {
      if (sequence === refreshSequence) set({ stale: false })
      return 'failed'
    }
    // A later fetch (user or quiet) started meanwhile; whichever started last wins.
    if (sequence !== refreshSequence) return 'superseded'
    if (!result.ok) {
      set({ stale: false })
      return 'failed'
    }
    const { items: previous, selected } = get()
    set({
      stale: false,
      items: result.value.issues,
      skipped: result.value.skipped,
      fetchedAt: result.value.fetchedAt,
      freshness: { key: listKey({ tab, state, projectIds: ids, query: appliedQuery, labels }), atMs: Date.now() },
      selected: selectionAfterRefresh(previous, result.value.issues, selected)
    })
    return 'done'
  }
}))
