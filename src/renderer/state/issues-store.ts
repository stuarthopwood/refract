// Issues view state (issue #504, spec 051): one cross-Project list, so a single store rather than
// the Pull requests store's per-repository slices. Fetches on open and on explicit Refresh or a
// filter change only, never on a timer.
import { create } from 'zustand'
import type { IpcError } from '../../shared/ipc'
import type { IssueListItem, IssueSkippedProject, IssueStateFilter, IssueTab } from '../../shared/ipc-issues'

interface IssuesState {
  tab: IssueTab
  state: IssueStateFilter
  /** Chosen Project ids; empty means every Project. */
  repositoryIds: string[]
  label: string | null
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
  setLabel(label: string | null): void
  setQuery(query: string): void
  clearFilters(): void
  select(selected: { repositoryId: string; number: number } | null): void
  /** `allRepositoryIds` is every added Project, used when no Project is chosen. */
  refresh(allRepositoryIds: string[]): Promise<void>
}

let refreshSequence = 0

export const useIssuesStore = create<IssuesState>((set, get) => ({
  tab: 'all',
  state: 'open',
  repositoryIds: [],
  label: null,
  query: '',
  appliedQuery: '',
  items: [],
  skipped: [],
  fetchedAt: null,
  loading: false,
  error: null,
  selected: null,
  setTab: (tab) => set({ tab }),
  setState: (state) => set({ state }),
  setRepositoryIds: (repositoryIds) => set({ repositoryIds }),
  setLabel: (label) => set({ label }),
  setQuery: (query) => set({ query }),
  clearFilters: () => set({ state: 'open', repositoryIds: [], label: null, query: '', appliedQuery: '' }),
  select: (selected) => set({ selected }),
  async refresh(allRepositoryIds) {
    const { tab, state, repositoryIds, label, query } = get()
    const ids = repositoryIds.length > 0 ? repositoryIds.filter((id) => allRepositoryIds.includes(id)) : allRepositoryIds
    refreshSequence += 1
    const sequence = refreshSequence
    set({ loading: true, error: null, appliedQuery: query })
    const result = await window.refract.issues.list(tab, state, ids, label, query.trim())
    // A newer refresh superseded this one; dropping the stale response keeps the list coherent.
    if (sequence !== refreshSequence) return
    if (!result.ok) {
      set({ loading: false, error: result.error, items: [], skipped: [] })
      return
    }
    set({ loading: false, items: result.value.issues, skipped: result.value.skipped, fetchedAt: result.value.fetchedAt })
  }
}))
