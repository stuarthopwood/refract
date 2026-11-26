// Issue #1849: a refresh of loaded figures blurs them under the shared overlay instead of dimming them.
// The repo has no jsdom, so the markup is rendered to a string and the overlay is a probe that records its `loading` prop.
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('@/state/usage-store', () => ({ useUsageStore: () => store.state }))
vi.mock('@/state', () => ({ useViewStore: (select: (state: unknown) => unknown) => select({ openChat: () => undefined }) }))
vi.mock('@/components/ui/loading-overlay', () => ({
  LoadingOverlay: ({ loading, children }: { loading: boolean; children: ReactNode }) =>
    createElement('div', { 'data-overlay': String(loading) }, children)
}))
vi.mock('@/components/ScreenHeader', () => ({ ScreenHeader: () => null }))
vi.mock('@/components/ScreenSection', () => ({ ScreenSection: () => createElement('div', { 'data-section': true }) }))
vi.mock('@/components/ProgressStrip', () => ({ ProgressStrip: () => null }))
vi.mock('./UsageFilters', () => ({ UsageFilters: () => null, clearUsageFilters: () => undefined, countActiveFilters: () => 0 }))
vi.mock('./UsageEmptyState', () => ({ UsageEmptyState: () => null }))
vi.mock('./AverageCards', () => ({ AverageCards: () => null }))
vi.mock('./BudgetCard', () => ({ BudgetCard: () => null }))
vi.mock('./CallLogTable', () => ({ CallLogTable: () => null }))
vi.mock('./FrustrationCard', () => ({ FrustrationCard: () => null }))
vi.mock('./HeadlineCards', () => ({ HeadlineCards: () => null }))
vi.mock('./SpendChart', () => ({ SpendChart: () => null }))
vi.mock('./TokenMixChart', () => ({ TokenMixChart: () => null }))
vi.mock('./UsageTables', () => ({ ModelTable: () => null, ProjectTable: () => null, ToolTable: () => null, TopSessionsTable: () => null }))

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
  })

  it('blurs_loaded_figures_under_the_overlay_while_refreshing', () => {
    const html = renderWith({ refreshing: true, loaded: true })
    expect(html).toContain('data-overlay="true"')
    expect(html).toContain('aria-busy="true"')
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
