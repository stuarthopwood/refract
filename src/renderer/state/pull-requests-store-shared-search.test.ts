import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestAcrossItem } from '../../shared/ipc-pull-requests'
import { PAGE_SIZE, usePullRequestsStore } from './pull-requests-store'

const listAcross = vi.fn()

interface SearchPage {
  ok: true
  value: { items: PullRequestAcrossItem[]; hasMore: boolean; skipped: never[]; fetchedAt: string }
}

const pr = (number: number): PullRequestAcrossItem => ({ repositoryId: 'a', number }) as PullRequestAcrossItem
const page = (...numbers: number[]): SearchPage => ({
  ok: true,
  value: { items: numbers.map(pr), hasMore: false, skipped: [], fetchedAt: '2026-11-27T10:00:00Z' }
})

/** One `listAcross` call the test settles by hand, so two callers can race on it. */
function deferredSearch(): { resolve: (value: SearchPage) => void } {
  let resolve!: (value: SearchPage) => void
  const promise = new Promise<SearchPage>((settle) => {
    resolve = settle
  })
  listAcross.mockImplementationOnce(() => promise)
  return { resolve }
}

beforeEach(() => {
  listAcross.mockReset()
  vi.stubGlobal('window', { refract: { pullRequests: { listAcross } } })
  usePullRequestsStore.getState().clearActiveCounts()
  usePullRequestsStore.setState({
    tab: 'all',
    state: 'open',
    repositoryIds: [],
    query: '',
    appliedQuery: '',
    items: [],
    limit: PAGE_SIZE,
    loading: false,
    fetchedAt: null,
    freshness: null,
    stale: false,
    error: null
  })
})

describe('sidebar count and default list share one search (FR-183)', () => {
  it('sidebar_count_then_list_make_one_listAcross_call', async () => {
    const search = deferredSearch()
    const store = usePullRequestsStore.getState()
    const count = store.refreshActiveCount(['a'])
    const list = store.refresh(['a'])
    search.resolve(page(1, 2, 3))
    await Promise.all([count, list])
    expect(listAcross).toHaveBeenCalledTimes(1)
    expect(usePullRequestsStore.getState().items).toHaveLength(3)
    expect(usePullRequestsStore.getState().activeCount.count).toBe(3)
  })

  it('list_then_sidebar_count_make_one_listAcross_call', async () => {
    const search = deferredSearch()
    const store = usePullRequestsStore.getState()
    const list = store.refresh(['a'])
    const count = store.refreshActiveCount(['a'])
    search.resolve(page(1, 2))
    await Promise.all([list, count])
    expect(listAcross).toHaveBeenCalledTimes(1)
    expect(usePullRequestsStore.getState().activeCount.count).toBe(2)
  })

  it('a_later_search_is_not_served_by_a_settled_one', async () => {
    listAcross.mockResolvedValue(page(1))
    await usePullRequestsStore.getState().refreshActiveCount(['a'])
    await usePullRequestsStore.getState().refresh(['a'])
    expect(listAcross).toHaveBeenCalledTimes(2)
  })

  it('a_different_project_set_does_not_share_the_request', async () => {
    listAcross.mockResolvedValue(page(1))
    const store = usePullRequestsStore.getState()
    await Promise.all([store.refreshActiveCount(['a']), store.refresh(['a', 'b'])])
    expect(listAcross).toHaveBeenCalledTimes(2)
  })

  it('a_filtered_refresh_leaves_the_count_and_makes_its_own_call', async () => {
    listAcross.mockResolvedValueOnce(page(1, 2, 3))
    await usePullRequestsStore.getState().refresh(['a'])
    expect(usePullRequestsStore.getState().activeCount.count).toBe(3)

    listAcross.mockResolvedValueOnce(page(9))
    usePullRequestsStore.getState().setState('all')
    await usePullRequestsStore.getState().refresh(['a'])
    expect(listAcross).toHaveBeenLastCalledWith('all', 'all', ['a'], '', PAGE_SIZE)
    expect(usePullRequestsStore.getState().items).toHaveLength(1)
    expect(usePullRequestsStore.getState().activeCount.count).toBe(3)
  })

  it('a_failed_shared_search_clears_the_count_and_lists_the_error', async () => {
    const error = { code: 'gh-failed', message: 'boom' }
    listAcross.mockResolvedValue({ ok: false, error })
    const store = usePullRequestsStore.getState()
    await Promise.all([store.refreshActiveCount(['a']), store.refresh(['a'])])
    expect(listAcross).toHaveBeenCalledTimes(1)
    expect(usePullRequestsStore.getState().error).toEqual(error)
    expect(usePullRequestsStore.getState().activeCount.count).toBeNull()
  })
})
