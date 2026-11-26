// Issue #1849. The repo has no jsdom, so the markup is rendered to a string; effects never run, which is why the
// card (shown after the delay) is asserted at `delayMs: 0`.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LoadingOverlay } from './loading-overlay'

const render = (props: { loading: boolean; delayMs?: number; overlay?: string }) =>
  renderToStaticMarkup(createElement(LoadingOverlay, { ...props, children: createElement('p', null, 'Stats') }))

describe('LoadingOverlay default card', () => {
  it('matches_the_session_start_notice_surface_with_a_spinner', () => {
    const html = render({ loading: true, delayMs: 0 })
    expect(html).toContain('rounded-xl bg-background/90')
    expect(html).toContain('px-6 py-4')
    expect(html).toContain('backdrop-blur-sm')
    expect(html).toContain('animate-spin')
    expect(html).toContain('Loading')
  })

  it('keeps_the_card_decorative_so_the_callers_polite_status_announces_it', () => {
    expect(render({ loading: true, delayMs: 0 })).toContain('aria-hidden="true" class="absolute')
  })

  it('shows_no_card_before_the_delay_passes_but_locks_the_content_at_once', () => {
    const html = render({ loading: true })
    expect(html).not.toContain('Loading')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('inert')
  })

  it('shows_nothing_when_not_loading', () => {
    const html = render({ loading: false })
    expect(html).not.toContain('Loading')
    expect(html).not.toContain('inert')
  })
})

describe('LoadingOverlay overlay branch', () => {
  it('keeps_the_scrim_and_never_draws_the_loading_card', () => {
    const html = render({ loading: true, delayMs: 0, overlay: 'Paused' })
    expect(html).toContain('bg-scrim-bg')
    expect(html).toContain('Paused')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('rounded-xl')
  })
})
