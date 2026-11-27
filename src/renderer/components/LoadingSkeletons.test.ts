// #1848: a list or detail pane in its first load shows skeleton blocks, never a dashed box or bare text.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DetailPaneSkeleton, ListRowsSkeleton, SkeletonLines } from './LoadingSkeletons'

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

describe('DetailPaneSkeleton label', () => {
  it('uses_the_caller_label_as_the_only_text', () => {
    const html = renderToStaticMarkup(createElement(DetailPaneSkeleton, { label: 'Loading diff…' }))
    expect(html).toContain('Loading diff…')
    expect(html).not.toContain('>Loading…<')
  })
})

describe('SkeletonLines', () => {
  it('draws_one_hidden_bar_per_width_and_one_sr_only_label', () => {
    const html = renderToStaticMarkup(createElement(SkeletonLines, { label: 'Loading models…', widths: ['w-1/2', 'w-1/3', 'w-2/3'] }))
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(3)
    expect(html.match(/Loading models…/g)).toHaveLength(1)
    expect(html).toContain('class="sr-only"')
    expect(html).not.toContain('border-dashed')
  })

  it('is_a_status_region_only_when_announce_is_set', () => {
    const quiet = renderToStaticMarkup(createElement(SkeletonLines, { label: 'Loading', widths: ['w-1/2'] }))
    const loud = renderToStaticMarkup(createElement(SkeletonLines, { label: 'Loading', widths: ['w-1/2'], announce: true }))
    expect(quiet).not.toContain('role=')
    expect(loud).toContain('role="status"')
  })
})
