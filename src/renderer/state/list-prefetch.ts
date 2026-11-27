// Idle prefetch of the default open Pull requests and Issues lists (issue #1895, FR-181 (a)): once
// GitHub is ready and Projects are loaded, fetch both lists into memory while nothing is waiting
// on them, so the first open shows rows at once (the mount reuses them under FR-180).
import { useAccountsStore } from './accounts'
import { isDefaultOpenList } from './list-freshness'
import { useIssuesStore } from './issues-store'
import { usePullRequestsStore } from './pull-requests-store'
import { useRepositoriesStore } from './repositories-store'

/** Idle gives way to first paint; this caps the wait on a busy main thread. */
const IDLE_TIMEOUT_MS = 5000

/** Fetches whichever default list is still at its default filters and not already fresh. */
export function prefetchDefaultLists(): void {
  if (useAccountsStore.getState().githubStatus !== 'ready') return
  const allIds = useRepositoriesStore.getState().repositories.map((repo) => repo.id)
  if (allIds.length === 0) return
  const pullRequests = usePullRequestsStore.getState()
  if (isDefaultOpenList(pullRequests)) void pullRequests.refreshIfStale(allIds)
  const issues = useIssuesStore.getState()
  if (isDefaultOpenList(issues)) void issues.refreshIfStale(allIds)
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS })
  else setTimeout(run, 0)
}

/** Waits for GitHub to be ready and Projects to load, then prefetches once, on idle. */
export function startListPrefetch(): void {
  let scheduled = false
  const check = (): void => {
    const ready =
      useAccountsStore.getState().githubStatus === 'ready' && useRepositoriesStore.getState().repositories.length > 0
    if (scheduled || !ready) return
    scheduled = true
    unsubscribeAccounts()
    unsubscribeRepositories()
    whenIdle(prefetchDefaultLists)
  }
  const unsubscribeAccounts = useAccountsStore.subscribe(check)
  const unsubscribeRepositories = useRepositoriesStore.subscribe(check)
  check()
}
