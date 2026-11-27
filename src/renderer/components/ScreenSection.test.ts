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

  it('keeps_a_screen_reader_loading_line_while_loading', () => {
    expect(render({ loading: true })).toContain('<span class="sr-only">Loading…</span>')
  })

  it('still_draws_the_empty_box_once_loaded_with_nothing_to_list', () => {
    const html = render({ empty: 'Nothing here' })
    expect(html).toContain('data-slot="empty"')
    expect(html).not.toContain('data-slot="skeleton"')
  })

  it('renders_the_rows_with_no_skeleton_once_loaded', () => {
    const html = render({})
    expect(html).toContain('Body')
    expect(html).not.toContain('data-slot="skeleton"')
    expect(html).not.toContain('section-skeleton')
  })

  it('shows_only_the_skeleton_when_loading_and_an_error_arrive_together', () => {
    const html = render({ loading: true, error: 'Could not load' })
    expect(html).toContain('data-slot="skeleton"')
    expect(html).not.toContain('Could not load')
    expect(html).not.toContain('Body')
  })
})
