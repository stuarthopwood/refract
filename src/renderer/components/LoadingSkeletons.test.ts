// #1848: a list or detail pane in its first load shows skeleton blocks, never a dashed box or bare text.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DetailPaneSkeleton, ListRowsSkeleton } from './LoadingSkeletons'

describe('ListRowsSkeleton', () => {
  it('draws_pulsing_rows_hidden_from_assistive_tech_without_a_dashed_box', () => {
    const html = renderToStaticMarkup(createElement(ListRowsSkeleton))
    expect(html).toContain('aria-hidden="true"')
    expect(html.match(/data-slot="skeleton"/g)?.length).toBeGreaterThan(2)
    expect(html).not.toContain('border-dashed')
  })

  it('draws_the_requested_number_of_rows', () => {
    const html = renderToStaticMarkup(createElement(ListRowsSkeleton, { rows: 2 }))
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(4)
  })
})

describe('DetailPaneSkeleton', () => {
  it('names_the_load_once_for_screen_readers_and_hides_the_blocks', () => {
    const html = renderToStaticMarkup(createElement(DetailPaneSkeleton))
    expect(html).toContain('role="status"')
    expect(html.match(/Loading…/g)).toHaveLength(1)
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('border-dashed')
  })
})
