// Cold-start hydration of the Pull requests and Issues stores from the on-disk List cache (issue
// #1895, FR-181 (b), (c)): the last good default open lists show at once, marked stale, and the
// idle prefetch (or the list's own mount fetch) swaps in the fresh result. A missing or unreadable
// cache is not an error: the lists just fetch as before.
import { useIssuesStore } from './issues-store'
import { usePullRequestsStore } from './pull-requests-store'

export async function hydrateListsFromCache(): Promise<void> {
  try {
    const result = await window.refract.listCache.read()
    if (!result.ok) return
    if (result.value.pullRequests) usePullRequestsStore.getState().hydrateFromCache(result.value.pullRequests)
    if (result.value.issues) useIssuesStore.getState().hydrateFromCache(result.value.issues)
  } catch (error) {
    console.debug('[refract] listCache.read: invoke failed (handler not registered yet)', error)
  }
}
