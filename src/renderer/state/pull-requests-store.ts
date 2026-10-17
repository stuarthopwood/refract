// Pull request list state, keyed per repository (specs/003-pull-request-management T010,
// data-model.md, FR-001 to FR-006). A separate store from `view-store.ts` (which only owns which
// top-level view/repository is showing, shared across specs 003/004/008) -- this one owns the
// current filter tab, narrowing query, loaded rows, loading/error state, and which pull request
// is selected, none of which any other spec needs.
import { create } from 'zustand'
import type { IpcError, PullRequestListResult, Result } from '../../shared/ipc'
import type { FilterTab, PullRequestStateFilter, PullRequestSummary } from '../../shared/github'

export interface PullRequestsRepoState {
  tab: FilterTab
  /** Issue #499 (2026-10-16 decision): the State control, independent of `tab`; default `'open'`. */
  state: PullRequestStateFilter
  query: string
  items: PullRequestSummary[]
  fetchedAt: string | null
  loading: boolean
  error: IpcError | null
  selectedNumber: number | null
}

function emptyRepoState(): PullRequestsRepoState {
  return { tab: 'all', state: 'open', query: '', items: [], fetchedAt: null, loading: false, error: null, selectedNumber: null }
}

// Stable reference for a repository with no store entry yet, so `stateFor` never returns a fresh
// object on every render -- a fresh `{}` literal here breaks Zustand's snapshot stability and
// causes a real "Maximum update depth exceeded" crash the instant a selector reads this for a
// repository with no entry (same pattern as queue-store's EMPTY_QUEUE / readout-store's
// EMPTY_READOUT_ENTRY / draft-store's EMPTY_DRAFT).
export const EMPTY_PULL_REQUESTS_REPO_STATE: PullRequestsRepoState = emptyRepoState()

/** The sidebar "Pull requests" entry's own trailing "N active" count (issue #569 decision 1): a
 *  SEPARATE per-repository slice from `byRepository` above -- it must never share state with
 *  whatever tab/items the visible pull request list currently shows, since the two can be
 *  fetched independently (the badge always reads the `involves`/`is:open` search regardless of
 *  which tab the list view has open). `count: null` covers both "never fetched" and "last fetch
 *  failed/unavailable" -- decision 4: both render as nothing, so they need no separate flag. */
export interface PullRequestsActiveCount {
  count: number | null
  loading: boolean
  fetchedAt: string | null
}

function emptyActiveCount(): PullRequestsActiveCount {
  return { count: null, loading: false, fetchedAt: null }
}

// Same stable-reference reasoning as `EMPTY_PULL_REQUESTS_REPO_STATE` above.
export const EMPTY_PULL_REQUESTS_ACTIVE_COUNT: PullRequestsActiveCount = emptyActiveCount()

interface PullRequestsState {
  byRepository: Record<string, PullRequestsRepoState>
  stateFor(repositoryId: string): PullRequestsRepoState
  setTab(repositoryId: string, tab: FilterTab): void
  /** Issue #499 (2026-10-16 decision): the State control, re-fetching like `setTab`. */
  setState(repositoryId: string, state: PullRequestStateFilter): void
  setQuery(repositoryId: string, query: string): void
  selectPullRequest(repositoryId: string, number: number | null): void
  refresh(repositoryId: string): Promise<void>
  activeCountByRepository: Record<string, PullRequestsActiveCount>
  activeCountFor(repositoryId: string): PullRequestsActiveCount
  /** Issue #569 decision 1/2: `involves`/`is:open` for one repository, never polled -- callers
   *  are the sidebar's own mount/default-repository-change effect, the window focus/visibility
   *  refresh and the active-account-change clear (`init-stores.ts`), and the pull request list's
   *  own explicit Refresh button (`PullRequestList.tsx`). */
  refreshActiveCount(repositoryId: string): Promise<void>
  /** Issue #569 decision 2(d): the active GitHub account changed -- every cached count is stale
   *  (`@me` now means someone else), so all of them are dropped rather than picking which ones
   *  to keep. */
  clearActiveCounts(): void
}

// High remediation (code-reviewer): module-level, not store state -- a per-repository counter
// bumped at the START of every `refresh()` call, so a response can check "am I still the latest
// request for this repository" after its `await` without needing its own store slice.
const refreshSequence: Record<string, number> = {}
// Same reasoning, kept as its own counter so a stale `involves` search can never race the
// unrelated visible-tab `refreshSequence` above (or vice versa).
const activeCountSequence: Record<string, number> = {}

function patch(
  byRepository: Record<string, PullRequestsRepoState>,
  repositoryId: string,
  changes: Partial<PullRequestsRepoState>
): Record<string, PullRequestsRepoState> {
  const current = byRepository[repositoryId] ?? emptyRepoState()
  return { ...byRepository, [repositoryId]: { ...current, ...changes } }
}

function patchActiveCount(
  byRepository: Record<string, PullRequestsActiveCount>,
  repositoryId: string,
  changes: Partial<PullRequestsActiveCount>
): Record<string, PullRequestsActiveCount> {
  const current = byRepository[repositoryId] ?? emptyActiveCount()
  return { ...byRepository, [repositoryId]: { ...current, ...changes } }
}

export const usePullRequestsStore = create<PullRequestsState>((set, get) => ({
  byRepository: {},
  stateFor: (repositoryId) => get().byRepository[repositoryId] ?? EMPTY_PULL_REQUESTS_REPO_STATE,
  setTab: (repositoryId, tab) => {
    set({ byRepository: patch(get().byRepository, repositoryId, { tab, selectedNumber: null }) })
    void get().refresh(repositoryId)
  },
  setState: (repositoryId, state) => {
    set({ byRepository: patch(get().byRepository, repositoryId, { state, selectedNumber: null }) })
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
    const result = await window.refract.pullRequests.list(repositoryId, before.tab, before.state, before.query || undefined)
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
  },
  activeCountByRepository: {},
  activeCountFor: (repositoryId) => get().activeCountByRepository[repositoryId] ?? EMPTY_PULL_REQUESTS_ACTIVE_COUNT,
  refreshActiveCount: async (repositoryId) => {
    activeCountSequence[repositoryId] = (activeCountSequence[repositoryId] ?? 0) + 1
    const sequence = activeCountSequence[repositoryId]
    set({
      activeCountByRepository: patchActiveCount(get().activeCountByRepository, repositoryId, { loading: true })
    })
    // Issue #569 decision 1: `involves` already covers author/assignee/mentioned/review-requested
    // in one search; the dedicated State control (issue #499) now does what an `is:open`
    // free-text query qualifier used to fake here, so only open pull requests count.
    // Gate round 2 fix (L2): a rejected IPC call (never expected to throw, but the bridge is not
    // guaranteed not to) used to leave `loading: true` stuck forever, which also silently
    // disabled the window-focus refresh and the mount effect (both skip while already loading).
    let result: Result<PullRequestListResult>
    try {
      result = await window.refract.pullRequests.list(repositoryId, 'involves', 'open')
    } catch {
      if (activeCountSequence[repositoryId] !== sequence) return
      set({
        activeCountByRepository: patchActiveCount(get().activeCountByRepository, repositoryId, {
          count: null,
          loading: false,
          fetchedAt: null
        })
      })
      return
    }
    if (activeCountSequence[repositoryId] !== sequence) return
    if (!result.ok) {
      // Decision 4: a failed/unavailable fetch clears to `null` (renders as nothing), never a
      // stale number and never an inline error in the sidebar row.
      set({
        activeCountByRepository: patchActiveCount(get().activeCountByRepository, repositoryId, {
          count: null,
          loading: false,
          fetchedAt: null
        })
      })
      return
    }
    set({
      activeCountByRepository: patchActiveCount(get().activeCountByRepository, repositoryId, {
        count: result.value.items.length,
        loading: false,
        fetchedAt: result.value.fetchedAt
      })
    })
  },
  clearActiveCounts: () => {
    // Gate round 1 fix (Code/Security/A11y/Arch High): bumping every repository's own sequence
    // number here means an in-flight `refreshActiveCount` fetch started BEFORE this clear, whose
    // `await` resolves AFTER it, sees its own sequence no longer match and bails -- without this
    // it could silently resurrect a stale, now-wrong-account count right after the clear.
    for (const key of Object.keys(activeCountSequence)) {
      activeCountSequence[key] = (activeCountSequence[key] ?? 0) + 1
    }
    set({ activeCountByRepository: {} })
  }
}))
