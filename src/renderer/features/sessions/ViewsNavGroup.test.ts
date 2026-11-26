// Issue #1778: the left rail Usage item uses the same gauge icon as the right rail. The repo has no jsdom, so the markup is rendered to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The real `@/state` barrel wires every store to `window` at import time; the nav group reads only these slices.
vi.mock('@/state', () => ({
  useViewStore: (select: (state: unknown) => unknown) =>
    select({ view: 'chat', openPullRequests: vi.fn(), openIssues: vi.fn(), openUsage: vi.fn(), openHome: vi.fn() }),
  useSplitStore: (select: (state: unknown) => unknown) => select({ paneSessionIds: [] }),
  useSessionsStore: (select: (state: unknown) => unknown) => select({ sessions: [] }),
  usePullRequestsStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ select: vi.fn(), activeCount: { count: null, partial: false } }),
    { getState: () => ({ refreshActiveCount: vi.fn() }) }
  ),
  useAccountsStore: (select: (state: unknown) => unknown) => select({ githubStatus: 'unavailable' }),
  useRepositoriesStore: (select: (state: unknown) => unknown) => select({ repositories: [] })
}))
vi.mock('@/state/pull-requests-store', () => ({ ACTIVE_COUNT_CAP_AT: 30 }))
vi.mock('@/lib/defaultRepository', () => ({ useDefaultRepositoryId: () => null }))

import { ViewsNavGroup } from './ViewsNavGroup'

describe('ViewsNavGroup', () => {
  it('usage_item_shows_the_gauge_icon_not_the_chart_icon', () => {
    const html = renderToStaticMarkup(createElement(ViewsNavGroup))
    const usageButton = html.slice(html.indexOf('aria-label="Usage"'), html.indexOf('</button>', html.indexOf('aria-label="Usage"')))
    expect(usageButton).toContain('lucide-gauge')
    expect(usageButton).not.toContain('lucide-chart-column')
  })
})
