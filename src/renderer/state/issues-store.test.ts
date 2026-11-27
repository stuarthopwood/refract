// FR-180: a remount inside the freshness window makes no `gh` call; stale, a changed filter and
// an explicit Refresh each make one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIST_FRESH_MS } from './list-freshness'
import { useIssuesStore } from './issues-store'

const list = vi.fn()
const ok = { ok: true, value: { issues: [], skipped: [], fetchedAt: '2026-11-27T00:00:00Z' } }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T10:00:00Z'))
  list.mockReset().mockResolvedValue(ok)
  vi.stubGlobal('window', { refract: { issues: { list } } })
  useIssuesStore.setState({
    tab: 'all',
    state: 'open',
    repositoryIds: [],
    labels: [],
    query: '',
    appliedQuery: '',
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

describe('issues list freshness', () => {
  it('makes_no_call_when_the_rows_were_fetched_under_a_minute_ago_for_the_same_filters', async () => {
    await useIssuesStore.getState().refreshIfStale(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS - 1)
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('fetches_again_once_the_rows_are_a_minute_old', async () => {
    await useIssuesStore.getState().refreshIfStale(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS)
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('fetches_when_the_tab_state_labels_or_project_set_changed', async () => {
    await useIssuesStore.getState().refreshIfStale(['r1'])
    useIssuesStore.getState().setTab('assigned')
    await useIssuesStore.getState().refreshIfStale(['r1'])
    useIssuesStore.getState().setState('closed')
    await useIssuesStore.getState().refreshIfStale(['r1'])
    useIssuesStore.getState().setLabels(['bug'])
    await useIssuesStore.getState().refreshIfStale(['r1'])
    await useIssuesStore.getState().refreshIfStale(['r1', 'r2'])
    expect(list).toHaveBeenCalledTimes(5)
  })

  it('fetches_when_a_search_is_typed_but_not_yet_applied', async () => {
    await useIssuesStore.getState().refreshIfStale(['r1'])
    useIssuesStore.getState().setQuery('flaky')
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('an_explicit_refresh_fetches_even_when_fresh', async () => {
    await useIssuesStore.getState().refreshIfStale(['r1'])
    await useIssuesStore.getState().refresh(['r1'])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('a_failed_fetch_leaves_nothing_fresh_so_the_next_mount_retries', async () => {
    list.mockResolvedValueOnce({ ok: false, error: { code: 'gh-failed', message: 'x' } })
    await useIssuesStore.getState().refreshIfStale(['r1'])
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('invalidating_freshness_makes_the_next_mount_fetch', async () => {
    await useIssuesStore.getState().refreshIfStale(['r1'])
    useIssuesStore.getState().invalidateFreshness()
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('a_quiet_refresh_after_a_write_restarts_the_window', async () => {
    await useIssuesStore.getState().refreshIfStale(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS - 1000)
    await useIssuesStore.getState().refreshQuiet(['r1'])
    vi.advanceTimersByTime(LIST_FRESH_MS - 1000)
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(list).toHaveBeenCalledTimes(2)
  })
})
