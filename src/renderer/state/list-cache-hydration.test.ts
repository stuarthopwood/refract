// FR-181 (b), (c): a cold start shows the on-disk default lists at once, marked stale, and the fresh
// fetch swaps the rows in and clears the mark. Only the untouched default open lists take the cache.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useIssuesStore } from './issues-store'
import { hydrateListsFromCache } from './list-cache-hydration'
import { prefetchDefaultLists } from './list-prefetch'
import { usePullRequestsStore } from './pull-requests-store'
import { useAccountsStore } from './accounts'
import { useRepositoriesStore } from './repositories-store'
import type { Repository } from '../../shared/model'
import type { IssueListResult } from '../../shared/ipc-issues'
import type { PullRequestAcrossResult } from '../../shared/ipc-pull-requests'

const read = vi.fn()
const listAcross = vi.fn()
const issuesList = vi.fn()

const cachedPullRequests = {
  items: [{ repositoryId: 'r1', repositoryName: 'one', number: 7, title: 'cached pr' }],
  hasMore: true,
  skipped: [],
  fetchedAt: '2026-11-26T09:00:00Z'
} as unknown as PullRequestAcrossResult
const cachedIssues = {
  issues: [{ repositoryId: 'r1', repositoryName: 'one', number: 3, title: 'cached issue' }],
  skipped: [],
  fetchedAt: '2026-11-26T09:00:00Z'
} as unknown as IssueListResult
const snapshot = { ok: true, value: { pullRequests: cachedPullRequests, issues: cachedIssues } }

beforeEach(() => {
  read.mockReset().mockResolvedValue(snapshot)
  listAcross.mockReset()
  issuesList.mockReset()
  vi.stubGlobal('window', { refract: { listCache: { read }, pullRequests: { listAcross }, issues: { list: issuesList } } })
  usePullRequestsStore.setState({
    tab: 'all', state: 'open', repositoryIds: [], query: '', appliedQuery: '', limit: 50,
    items: [], skipped: [], hasMore: false, fetchedAt: null, freshness: null, stale: false, loading: false, error: null
  })
  useIssuesStore.setState({
    tab: 'all', state: 'open', repositoryIds: [], labels: [], query: '', appliedQuery: '',
    items: [], skipped: [], fetchedAt: null, freshness: null, stale: false, loading: false, error: null
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('hydrateListsFromCache', () => {
  it('fills_both_stores_with_the_cached_rows_marked_stale_and_not_fresh', async () => {
    await hydrateListsFromCache()
    const pullRequests = usePullRequestsStore.getState()
    expect(pullRequests.items).toHaveLength(1)
    expect(pullRequests.hasMore).toBe(true)
    expect(pullRequests.fetchedAt).toBe('2026-11-26T09:00:00Z')
    expect(pullRequests.stale).toBe(true)
    expect(pullRequests.freshness).toBeNull()
    const issues = useIssuesStore.getState()
    expect(issues.items).toHaveLength(1)
    expect(issues.stale).toBe(true)
    expect(issues.freshness).toBeNull()
  })

  it('leaves_the_stores_alone_when_the_cache_is_empty_unreadable_or_the_invoke_fails', async () => {
    read.mockResolvedValueOnce({ ok: true, value: { pullRequests: null, issues: null } })
    await hydrateListsFromCache()
    read.mockResolvedValueOnce({ ok: false, error: { code: 'io', message: 'x' } })
    await hydrateListsFromCache()
    read.mockRejectedValueOnce(new Error('not registered'))
    await hydrateListsFromCache()
    expect(usePullRequestsStore.getState().items).toEqual([])
    expect(useIssuesStore.getState().stale).toBe(false)
  })

  it('does_not_replace_rows_a_fetch_already_delivered', async () => {
    usePullRequestsStore.setState({ items: [{ number: 99 } as never], fetchedAt: 'later' })
    useIssuesStore.setState({ loading: true })
    await hydrateListsFromCache()
    expect(usePullRequestsStore.getState().items[0]?.number).toBe(99)
    expect(usePullRequestsStore.getState().stale).toBe(false)
    expect(useIssuesStore.getState().items).toEqual([])
  })

  it('does_not_show_the_default_rows_under_a_filter_the_developer_already_changed', async () => {
    usePullRequestsStore.getState().setState('closed')
    useIssuesStore.getState().setLabels(['bug'])
    await hydrateListsFromCache()
    expect(usePullRequestsStore.getState().items).toEqual([])
    expect(useIssuesStore.getState().items).toEqual([])
  })
})

describe('the stale-then-fresh swap', () => {
  it('the_fresh_fetch_replaces_the_cached_rows_and_clears_the_stale_mark', async () => {
    await hydrateListsFromCache()
    listAcross.mockResolvedValue({
      ok: true,
      value: { items: [{ repositoryId: 'r1', repositoryName: 'one', number: 8, title: 'fresh' }], hasMore: false, skipped: [], fetchedAt: 'now' }
    })
    issuesList.mockResolvedValue({ ok: true, value: { issues: [], skipped: [], fetchedAt: 'now' } })
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(usePullRequestsStore.getState().items.map((pr) => pr.number)).toEqual([8])
    expect(usePullRequestsStore.getState().stale).toBe(false)
    expect(useIssuesStore.getState().items).toEqual([])
    expect(useIssuesStore.getState().stale).toBe(false)
  })

  it('a_failed_fetch_drops_the_cached_rows_for_the_error_instead_of_keeping_them_marked', async () => {
    await hydrateListsFromCache()
    issuesList.mockResolvedValue({ ok: false, error: { code: 'gh-failed', message: 'down' } })
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(useIssuesStore.getState().items).toEqual([])
    expect(useIssuesStore.getState().stale).toBe(false)
    expect(useIssuesStore.getState().error?.code).toBe('gh-failed')
  })

  it('a_filter_change_clears_the_stale_mark_before_the_new_rows_arrive', async () => {
    await hydrateListsFromCache()
    usePullRequestsStore.getState().setTab('mine' as never)
    useIssuesStore.getState().setState('closed')
    expect(usePullRequestsStore.getState().stale).toBe(false)
    expect(useIssuesStore.getState().stale).toBe(false)
  })

  it('the_idle_prefetch_still_fetches_over_the_cached_rows_because_they_are_not_fresh', async () => {
    useAccountsStore.setState({ githubStatus: 'ready' })
    useRepositoriesStore.setState({ repositories: [{ id: 'r1', name: 'r1' } as Repository] })
    listAcross.mockResolvedValue({ ok: true, value: { items: [], hasMore: false, skipped: [], fetchedAt: 'now' } })
    issuesList.mockResolvedValue({ ok: true, value: { issues: [], skipped: [], fetchedAt: 'now' } })
    await hydrateListsFromCache()
    prefetchDefaultLists()
    await vi.waitFor(() => expect(usePullRequestsStore.getState().stale).toBe(false))
    await vi.waitFor(() => expect(useIssuesStore.getState().stale).toBe(false))
    expect(listAcross).toHaveBeenCalledTimes(1)
    expect(issuesList).toHaveBeenCalledTimes(1)
  })
})
