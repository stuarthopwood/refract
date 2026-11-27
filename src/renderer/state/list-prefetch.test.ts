// FR-181 (a): the default open lists are fetched into memory on idle, and the later mount reuses them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAccountsStore } from './accounts'
import { useIssuesStore } from './issues-store'
import { prefetchDefaultLists, startListPrefetch } from './list-prefetch'
import { usePullRequestsStore } from './pull-requests-store'
import { useRepositoriesStore } from './repositories-store'
import type { Repository } from '../../shared/model'

const listAcross = vi.fn()
const issuesList = vi.fn()

const repo = (id: string) => ({ id, name: id }) as Repository

beforeEach(() => {
  listAcross.mockReset().mockResolvedValue({ ok: true, value: { items: [], hasMore: false, skipped: [], fetchedAt: 'now' } })
  issuesList.mockReset().mockResolvedValue({ ok: true, value: { issues: [], skipped: [], fetchedAt: 'now' } })
  vi.stubGlobal('window', { refract: { pullRequests: { listAcross }, issues: { list: issuesList } } })
  useAccountsStore.setState({ githubStatus: 'ready' })
  useRepositoriesStore.setState({ repositories: [repo('r1')] })
  usePullRequestsStore.setState({ tab: 'all', state: 'open', repositoryIds: [], query: '', appliedQuery: '', limit: 50, freshness: null })
  useIssuesStore.setState({ tab: 'all', state: 'open', repositoryIds: [], labels: [], query: '', appliedQuery: '', freshness: null })
})

afterEach(() => vi.unstubAllGlobals())

describe('prefetchDefaultLists', () => {
  it('fetches_both_default_open_lists_once_and_the_later_mount_reuses_them', async () => {
    prefetchDefaultLists()
    await vi.waitFor(() => expect(usePullRequestsStore.getState().freshness).not.toBeNull())
    await vi.waitFor(() => expect(useIssuesStore.getState().freshness).not.toBeNull())
    await usePullRequestsStore.getState().refreshIfStale(['r1'])
    await useIssuesStore.getState().refreshIfStale(['r1'])
    expect(listAcross).toHaveBeenCalledTimes(1)
    expect(issuesList).toHaveBeenCalledTimes(1)
  })

  it('does_nothing_before_github_is_ready_or_without_projects', () => {
    useAccountsStore.setState({ githubStatus: 'unknown' } as never)
    prefetchDefaultLists()
    useAccountsStore.setState({ githubStatus: 'ready' })
    useRepositoriesStore.setState({ repositories: [] })
    prefetchDefaultLists()
    expect(listAcross).not.toHaveBeenCalled()
    expect(issuesList).not.toHaveBeenCalled()
  })

  it('leaves_a_list_alone_when_its_filters_are_not_the_default_open_list', () => {
    usePullRequestsStore.setState({ state: 'closed' })
    useIssuesStore.setState({ labels: ['bug'] })
    prefetchDefaultLists()
    expect(listAcross).not.toHaveBeenCalled()
    expect(issuesList).not.toHaveBeenCalled()
  })
})

describe('startListPrefetch', () => {
  it('waits_for_projects_to_load_then_prefetches_once_on_idle', () => {
    vi.useFakeTimers()
    useRepositoriesStore.setState({ repositories: [] })
    startListPrefetch()
    vi.runAllTimers()
    expect(listAcross).not.toHaveBeenCalled()
    useRepositoriesStore.setState({ repositories: [repo('r1')] })
    useRepositoriesStore.setState({ repositories: [repo('r1'), repo('r2')] })
    vi.runAllTimers()
    expect(listAcross).toHaveBeenCalledTimes(1)
    expect(issuesList).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
