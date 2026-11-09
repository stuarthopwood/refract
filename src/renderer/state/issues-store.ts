// Issues view state (issue #504, spec 051): one cross-Project list, so a single store rather than
// the Pull requests store's per-repository slices. Fetches on open and on explicit Refresh or a
// filter change only, never on a timer; a `github:changed` write adds one quiet refetch (#1589).
import { create } from 'zustand'
import { selectionAfterRefresh } from './selection-handoff'
import type { QuietRefreshOutcome } from './pull-requests-store'
import { effectiveFilterQuery } from '@/components/filterQueryRule'
import type { IpcError, Result } from '../../shared/ipc'
import type { IssueListItem, IssueListResult, IssueSkippedProject, IssueStateFilter, IssueTab } from '../../shared/ipc-issues'

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
  /** Background refetch with the applied filters after a `github:changed` write: no loading or error state, old rows kept on failure, selection moves on if its row is gone. */
  refreshQuiet(allRepositoryIds: string[]): Promise<QuietRefreshOutcome>
}

let refreshSequence = 0

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
  loading: false,
  error: null,
  selected: null,
  // A filter change drops the selection so the detail pane never shows an issue the list no longer has.
  setTab: (tab) => set({ tab, selected: null }),
  setState: (state) => set({ state, selected: null }),
  setRepositoryIds: (repositoryIds) => set({ repositoryIds, selected: null }),
  setLabels: (labels) => set({ labels, selected: null }),
  removeLabel: (label) => set((s) => ({ labels: s.labels.filter((l) => l !== label), selected: null })),
  setQuery: (query) => set({ query }),
  // A fresh `repositoryIds` array on every reset is what re-runs the list's fetch effect, so Clear
  // filters refetches even when only the search was active.
  clearFilters: () =>
    set({ state: 'open', repositoryIds: [], labels: [], query: '', appliedQuery: '', selected: null }),
  select: (selected) => set({ selected }),
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
      set({ loading: false, error: result.error, items: [], skipped: [] })
      return
    }
    set({ loading: false, items: result.value.issues, skipped: result.value.skipped, fetchedAt: result.value.fetchedAt })
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
      return 'failed'
    }
    // A later fetch (user or quiet) started meanwhile; whichever started last wins.
    if (sequence !== refreshSequence) return 'superseded'
    if (!result.ok) return 'failed'
    const { items: previous, selected } = get()
    set({
      items: result.value.issues,
      skipped: result.value.skipped,
      fetchedAt: result.value.fetchedAt,
      selected: selectionAfterRefresh(previous, result.value.issues, selected)
    })
    return 'done'
  }
}))
