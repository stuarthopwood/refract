// Issue #1848: a section that is still loading shows skeleton blocks, never the dashed `Empty` box.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScreenSection } from './ScreenSection'

const render = (props: Partial<Parameters<typeof ScreenSection>[0]>) =>
  renderToStaticMarkup(createElement(ScreenSection, { title: 'Overview', ...props }, createElement('p', null, 'Body')))

describe('ScreenSection loading', () => {
  it('shows_skeleton_blocks_and_no_dashed_box_while_loading', () => {
    const html = render({ loading: true, empty: 'Nothing here' })
    expect(html).toContain('data-slot="skeleton"')
    expect(html).not.toContain('data-slot="empty"')
    expect(html).not.toContain('border-dashed')
    expect(html).not.toContain('Nothing here')
    expect(html).not.toContain('Body')
  })

  it('keeps_a_screen_reader_loading_line_and_stops_the_pulse_under_reduced_motion', () => {
    const html = render({ loading: true })
    expect(html).toContain('<span class="sr-only">Loading…</span>')
    expect(html).toContain('motion-reduce:animate-none')
  })

  it('still_draws_the_empty_box_once_loaded_with_nothing_to_list', () => {
    const html = render({ empty: 'Nothing here' })
    expect(html).toContain('data-slot="empty"')
    expect(html).not.toContain('data-slot="skeleton"')
  })
})
