// Pull request list state, keyed per repository (specs/003-pull-request-management T010,
// data-model.md, FR-001 to FR-006). A separate store from `view-store.ts` (which only owns which
// top-level view/repository is showing, shared across specs 003/004/008) -- this one owns the
// current filter tab, narrowing query, loaded rows, loading/error state, and which pull request
// is selected, none of which any other spec needs.
import { create } from 'zustand'
import type { IpcError } from '../../shared/ipc'
import type { FilterTab, PullRequestSummary } from '../../shared/github'

export interface PullRequestsRepoState {
  tab: FilterTab
  query: string
  items: PullRequestSummary[]
  fetchedAt: string | null
  loading: boolean
  error: IpcError | null
  selectedNumber: number | null
}

function emptyRepoState(): PullRequestsRepoState {
  return { tab: 'open', query: '', items: [], fetchedAt: null, loading: false, error: null, selectedNumber: null }
}

// Stable reference for a repository with no store entry yet, so `stateFor` never returns a fresh
// object on every render -- a fresh `{}` literal here breaks Zustand's snapshot stability and
// causes a real "Maximum update depth exceeded" crash the instant a selector reads this for a
// repository with no entry (same pattern as queue-store's EMPTY_QUEUE / readout-store's
// EMPTY_READOUT_ENTRY / draft-store's EMPTY_DRAFT).
export const EMPTY_PULL_REQUESTS_REPO_STATE: PullRequestsRepoState = emptyRepoState()

interface PullRequestsState {
  byRepository: Record<string, PullRequestsRepoState>
  stateFor(repositoryId: string): PullRequestsRepoState
  setTab(repositoryId: string, tab: FilterTab): void
  setQuery(repositoryId: string, query: string): void
  selectPullRequest(repositoryId: string, number: number | null): void
  refresh(repositoryId: string): Promise<void>
}

// High remediation (code-reviewer): module-level, not store state -- a per-repository counter
// bumped at the START of every `refresh()` call, so a response can check "am I still the latest
// request for this repository" after its `await` without needing its own store slice.
const refreshSequence: Record<string, number> = {}

function patch(
  byRepository: Record<string, PullRequestsRepoState>,
  repositoryId: string,
  changes: Partial<PullRequestsRepoState>
): Record<string, PullRequestsRepoState> {
  const current = byRepository[repositoryId] ?? emptyRepoState()
  return { ...byRepository, [repositoryId]: { ...current, ...changes } }
}

export const usePullRequestsStore = create<PullRequestsState>((set, get) => ({
  byRepository: {},
  stateFor: (repositoryId) => get().byRepository[repositoryId] ?? EMPTY_PULL_REQUESTS_REPO_STATE,
  setTab: (repositoryId, tab) => {
    set({ byRepository: patch(get().byRepository, repositoryId, { tab, selectedNumber: null }) })
    void get().refresh(repositoryId)
  },
  setQuery: (repositoryId, query) => {
    set({ byRepository: patch(get().byRepository, repositoryId, { query }) })
  },
  selectPullRequest: (repositoryId, number) => {
    set({ byRepository: patch(get().byRepository, repositoryId, { selectedNumber: number }) })
  },
  refresh: async (repositoryId) => {
    const before = get().stateFor(repositoryId)
    // High remediation (code-reviewer): a per-repository sequence number so a slower, now-stale
    // `list()` response (an earlier tab switch, or a rapid double-switch) can never overwrite a
    // newer one that already landed -- `refresh` had no request-sequencing token at all before.
    refreshSequence[repositoryId] = (refreshSequence[repositoryId] ?? 0) + 1
    const sequence = refreshSequence[repositoryId]
    set({ byRepository: patch(get().byRepository, repositoryId, { loading: true, error: null }) })
    const result = await window.refract.pullRequests.list(repositoryId, before.tab, before.query || undefined)
    if (refreshSequence[repositoryId] !== sequence) return
    if (!result.ok) {
      set({ byRepository: patch(get().byRepository, repositoryId, { loading: false, error: result.error }) })
      return
    }
    set({
      byRepository: patch(get().byRepository, repositoryId, {
        loading: false,
        error: null,
        items: result.value.items,
        fetchedAt: result.value.fetchedAt
      })
    })
  }
}))
