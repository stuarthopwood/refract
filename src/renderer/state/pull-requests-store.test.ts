// FR-180: a remount inside the freshness window makes no `gh` call; stale, a changed filter and
// an explicit Refresh each make one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIST_FRESH_MS } from './list-freshness'
import { usePullRequestsStore } from './pull-requests-store'

const listAcross = vi.fn()
const ok = { ok: true, value: { items: [], hasMore: false, skipped: [], fetchedAt: '2026-11-27T00:00:00Z' } }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T10:00:00Z'))
  listAcross.mockReset().mockResolvedValue(ok)
  vi.stubGlobal('window', { refract: { pullRequests: { listAcross } } })
  usePullRequestsStore.setState({
    tab: 'all',
    state: 'open',
    repositoryIds: [],
    query: '',
    appliedQuery: '',
    limit: 50,
    items: [],
    freshness: null,
    loading: false,
    error: null
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('pull requests list freshness', () => {
  it('makes_no_call_when_the_rows_were_fetched_under_a_minute_ago_for_the_same_filters', async () => {
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS - 1)
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(1)
  })

  it('fetches_again_once_the_rows_are_a_minute_old', async () => {
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS)
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(2)
  })

  it('fetches_when_the_tab_state_or_project_set_changed', async () => {
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    usePullRequestsStore.getState().setTab('authored')
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    usePullRequestsStore.getState().setState('closed')
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    await usePullRequestsStore.getState().refreshIfStale(['r1', 'r2'])
    expect(listAcross).toHaveBeenCalledTimes(4)
  })

  it('fetches_when_a_search_is_typed_but_not_yet_applied', async () => {
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    usePullRequestsStore.getState().setQuery('flaky')
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(2)
  })

  it('an_explicit_refresh_and_show_more_fetch_even_when_fresh', async () => {
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    await usePullRequestsStore.getState().refresh(['r1'])
    await usePullRequestsStore.getState().loadMore(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(3)
  })

  it('a_failed_fetch_leaves_nothing_fresh_so_the_next_mount_retries', async () => {
    listAcross.mockResolvedValueOnce({ ok: false, error: { code: 'gh-failed', message: 'x' } })
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(2)
  })

  it('invalidating_freshness_makes_the_next_mount_fetch', async () => {
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    usePullRequestsStore.getState().invalidateFreshness()
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(2)
  })

  it('a_quiet_refresh_after_a_write_restarts_the_window', async () => {
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS - 1000)
    await usePullRequestsStore.getState().refreshQuiet(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS - 1000)
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(2)
  })
})
