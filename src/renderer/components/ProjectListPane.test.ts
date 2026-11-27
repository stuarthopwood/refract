// #1848: the first fetch shows skeleton rows in the list's shape, never the dashed empty state or a blank pane.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The pane only needs `formatRelativeTime`; the real module pulls in the whole store graph.
vi.mock('@/features/sessions/sessionDisplay', () => ({ formatRelativeTime: () => 'just now' }))
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectListPane, type ProjectListPaneProps } from './ProjectListPane'

function render(overrides: Partial<ProjectListPaneProps<'all'>>): string {
  const props: ProjectListPaneProps<'all'> = {
    noun: { singular: 'issue', plural: 'issues' },
    idPrefix: 'test-list',
    tabs: [{ value: 'all', label: 'All' }],
    tab: 'all',
    onTabChange: () => undefined,
    state: 'open',
    onStateChange: () => undefined,
    projects: [],
    repositoryIds: [],
    onRepositoryIdsChange: () => undefined,
    query: '',
    appliedQuery: '',
    onQueryChange: () => undefined,
    onRefresh: () => undefined,
    onClearFilters: () => undefined,
    loading: false,
    fetchedAt: null,
    error: null,
    skipped: [],
    itemCount: 0,
    projectCount: 0,
    children: null,
    ...overrides
  }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ProjectListPane<'all'>, props)))
}

describe('ProjectListPane first load', () => {
  it('shows_skeleton_rows_and_no_dashed_empty_state_while_the_first_fetch_is_in_flight', () => {
    const html = render({ loading: true })
    expect(html).toContain('data-slot="list-rows-skeleton"')
    expect(html).not.toContain('border-dashed')
    expect(html).not.toContain('No issues match')
  })

  it('shows_the_empty_copy_once_the_fetch_finishes_with_no_rows', () => {
    const html = render({ loading: false, fetchedAt: '2026-11-27T00:00:00Z' })
    expect(html).not.toContain('list-rows-skeleton')
    expect(html).toContain('No issues match this tab.')
  })
})

// FR-181 (c): cached rows show at once with a quiet "refreshing" hint, not the Loading card or the blur.
describe('ProjectListPane stale rows', () => {
  const rows = createElement('div', { 'data-testid': 'row' }, 'cached row')

  it('shows_the_cached_rows_with_a_quiet_refreshing_hint_while_the_fresh_fetch_runs', () => {
    const html = render({ stale: true, loading: true, itemCount: 1, fetchedAt: '2026-11-26T09:00:00Z', children: rows })
    expect(html).toContain('cached row')
    expect(html).toContain('Saved issues · refreshing…')
    expect(html).not.toContain('Loading…')
    expect(html).not.toContain('list-rows-skeleton')
  })

  it('does_not_blur_or_lock_the_stale_rows_even_when_the_list_blurs_while_loading', () => {
    const stale = render({ stale: true, blurWhileLoading: true, loading: true, itemCount: 1, children: rows })
    const fresh = render({ stale: false, blurWhileLoading: true, loading: true, itemCount: 1, children: rows })
    expect(fresh).toContain('aria-busy="true"')
    expect(stale).not.toContain('aria-busy="true"')
  })

  it('drops_the_hint_and_shows_last_updated_once_fresh_rows_arrive', () => {
    const html = render({ stale: false, loading: false, itemCount: 1, projectCount: 1, fetchedAt: '2026-11-27T00:00:00Z', children: rows })
    expect(html).not.toContain('refreshing')
    expect(html).toContain('Last updated just now')
  })
})
