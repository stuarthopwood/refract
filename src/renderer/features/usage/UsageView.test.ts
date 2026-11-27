// Issue #1849: a refresh of loaded figures blurs them under the shared overlay instead of dimming them, keeps them interactive
// and announces the refresh. The repo has no jsdom, so the markup is rendered to a string; the overlay is a probe that records its props.
import { createElement, type ReactNode } from 'react'
import type * as ReactModule from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
const announce = vi.hoisted(() => vi.fn())

// Effects never run under renderToStaticMarkup; running them inline makes the first render's transition observable.
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof ReactModule>()), useEffect: (effect: () => void) => void effect() }))
vi.mock('@/lib/use-cleared-announcement', () => ({ useClearedAnnouncement: () => ['', announce] }))
vi.mock('@/state/usage-store', () => ({
  useUsageStore: Object.assign(() => store.state, { getState: () => ({ open: () => undefined, close: () => undefined }) })
}))
vi.mock('@/state', () => ({ useViewStore: (select: (state: unknown) => unknown) => select({ openChat: () => undefined }) }))
vi.mock('@/components/ui/loading-overlay', () => ({
  LoadingOverlay: ({
    loading,
    inertWhileLoading,
    className,
    contentClassName,
    children
  }: {
    loading: boolean
    inertWhileLoading?: boolean
    className?: string
    contentClassName?: string
    children: ReactNode
  }) =>
    createElement(
      'div',
      { 'data-overlay': String(loading), 'data-inert-while-loading': String(inertWhileLoading), className, 'data-content-class': contentClassName },
      children
    )
}))
vi.mock('@/components/ScreenHeader', () => ({ ScreenHeader: () => null }))
vi.mock('@/components/ScreenSection', () => ({
  ScreenSection: ({ title, loading }: { title: string; loading?: boolean }) => createElement('div', { 'data-section': title, 'data-loading': String(loading === true) })
}))
vi.mock('@/components/ProgressStrip', () => ({ ProgressStrip: () => null }))
vi.mock('./UsageFilters', () => ({ UsageFilters: () => null, clearUsageFilters: () => undefined, countActiveFilters: () => 0 }))
vi.mock('./UsageEmptyState', () => ({ UsageEmptyState: () => null }))
vi.mock('./AverageCards', () => ({ AverageCards: ({ loading }: { loading: boolean }) => createElement('div', { 'data-averages-loading': String(loading) }) }))
vi.mock('./BudgetCard', () => ({ BudgetCard: () => null }))
vi.mock('./CallLogTable', () => ({ CallLogTable: () => null }))
vi.mock('./FrustrationCard', () => ({ FrustrationCard: () => null }))
vi.mock('./HeadlineCards', () => ({ HeadlineCards: () => null }))
vi.mock('./SpendChart', () => ({ SpendChart: () => null }))
vi.mock('./TokenMixChart', () => ({ TokenMixChart: () => null }))
vi.mock('./UsageTables', () => ({ ErrorCategoryTable: () => null, ModelTable: () => null, ProjectTable: () => null, ToolTable: () => null, TopSessionsTable: () => null }))

import { UsageView } from './UsageView'

const status = { running: false, scanCompleted: true, found: true, sessionsSeen: 3, sessionsDone: 3, sessionsDir: '' }

function renderWith(overrides: Record<string, unknown>): string {
  store.state = {
    status,
    error: null,
    loaded: true,
    refreshing: false,
    filters: {},
    summary: { calls: 4 },
    timeseries: [],
    tokenMix: [],
    byProject: [],
    byModel: [],
    byTool: [],
    errorCategories: [],
    topSessions: [],
    calls: { rows: [] },
    budget: null,
    jokes: false,
    frustration: null,
    bucket: 'day',
    setBucket: () => undefined,
    ...overrides
  }
  return renderToStaticMarkup(createElement(UsageView))
}

describe('UsageView refresh overlay', () => {
  beforeEach(() => {
    store.state = {}
    announce.mockClear()
  })

  it('blurs_loaded_figures_under_the_overlay_while_refreshing', () => {
    const html = renderWith({ refreshing: true, loaded: true })
    expect(html).toContain('data-overlay="true"')
    expect(html).toContain('aria-busy="true"')
  })

  it('keeps_the_content_interactive_so_a_bucket_sort_or_page_control_keeps_focus', () => {
    expect(renderWith({ refreshing: true, loaded: true })).toContain('data-inert-while-loading="false"')
  })

  it('sets_aria_busy_exactly_once_so_the_overlay_does_not_duplicate_it', () => {
    const html = renderWith({ refreshing: true, loaded: true })
    expect(html.match(/aria-busy=/g)).toHaveLength(1)
  })

  it('keeps_the_wrapper_and_content_as_flex_columns_that_fill_the_scroll_container', () => {
    const html = renderWith({ refreshing: true, loaded: true })
    expect(html).toMatch(/class="flex flex-1 flex-col"/)
    expect(html).toContain('data-content-class="flex flex-1 flex-col gap-8"')
  })

  it('announces_updating_when_a_refresh_of_loaded_figures_starts', () => {
    renderWith({ refreshing: true, loaded: true })
    expect(announce).toHaveBeenCalledWith('Updating usage')
  })

  it('stays_silent_on_first_load_and_when_idle', () => {
    renderWith({ refreshing: true, loaded: false })
    renderWith({ refreshing: false, loaded: true })
    expect(announce).not.toHaveBeenCalled()
  })

  it('no_longer_dims_the_figures_with_opacity', () => {
    expect(renderWith({ refreshing: true, loaded: true })).not.toContain('opacity-60')
  })

  it('keeps_first_load_on_the_section_skeletons_without_the_overlay', () => {
    const html = renderWith({ refreshing: true, loaded: false })
    expect(html).toContain('data-overlay="false"')
    expect(html).toContain('aria-busy="true"')
  })

  it('leaves_the_overlay_off_when_idle', () => {
    const html = renderWith({ refreshing: false, loaded: true })
    expect(html).toContain('data-overlay="false"')
    expect(html).toContain('aria-busy="false"')
  })

  it('anchors_the_overlay_inside_the_scroll_container_so_the_card_follows_scrolling', () => {
    const html = renderWith({ refreshing: true, loaded: true })
    expect(html).toMatch(/overflow-y-auto[^>]*><div data-overlay="true"/)
  })
})

describe('UsageView first-load skeletons', () => {
  it('shows_the_overview_skeleton_until_the_first_load_finishes', () => {
    const html = renderWith({ loaded: false, summary: null })
    expect(html).toContain('data-section="Overview" data-loading="true"')
    expect(html).toContain('data-averages-loading="true"')
  })

  it('stops_skeletoning_the_overview_when_the_load_finished_but_the_summary_failed', () => {
    const html = renderWith({ loaded: true, summary: null, error: 'boom' })
    expect(html).toContain('data-section="Overview" data-loading="false"')
    expect(html).toContain('data-averages-loading="false"')
  })
})
