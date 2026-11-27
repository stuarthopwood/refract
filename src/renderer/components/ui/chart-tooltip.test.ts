import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChartAnnouncement, ChartTooltipBody, chartTooltipText, cursorAfterKey, pointerIndex, type ChartTooltipEntry } from './chart-tooltip'
import { Sparkline, StackedBarChart, BarChart, type ChartView } from './chart'
import { TooltipProvider } from './tooltip'

const entry: ChartTooltipEntry = {
  heading: 'Nov 3',
  lines: [
    { label: 'opus', value: '$1.20' },
    { label: 'sonnet', value: '$0.30' },
    { label: 'Total', value: '$1.50', strong: true }
  ]
}

const view: ChartView = { asTable: false, tableId: 'tbl', toggle: null }
const inProvider = (node: ReactElement): string => renderToStaticMarkup(createElement(TooltipProvider, null, node))

describe('pointerIndex', () => {
  it('column_mode_splits_the_plot_into_equal_slots', () => {
    expect([0, 0.24, 0.26, 0.99, 1].map((f) => pointerIndex(f, 4, 'column'))).toEqual([0, 0, 1, 3, 3])
  })

  it('point_mode_snaps_to_the_nearest_point', () => {
    expect([0, 0.2, 0.3, 0.8, 1].map((f) => pointerIndex(f, 5, 'point'))).toEqual([0, 1, 1, 3, 4])
  })

  it('a_single_point_is_always_index_zero', () => {
    expect(pointerIndex(0.7, 1, 'point')).toBe(0)
  })
})

describe('cursorAfterKey', () => {
  it('arrows_step_and_stop_at_the_ends', () => {
    expect(cursorAfterKey(1, 'ArrowRight', 3)).toBe(2)
    expect(cursorAfterKey(2, 'ArrowRight', 3)).toBe(2)
    expect(cursorAfterKey(1, 'ArrowLeft', 3)).toBe(0)
    expect(cursorAfterKey(0, 'ArrowUp', 3)).toBe(0)
  })

  it('first_arrow_enters_from_the_nearest_end', () => {
    expect(cursorAfterKey(null, 'ArrowRight', 3)).toBe(0)
    expect(cursorAfterKey(null, 'ArrowLeft', 3)).toBe(2)
  })

  it('home_end_and_escape', () => {
    expect(cursorAfterKey(1, 'Home', 5)).toBe(0)
    expect(cursorAfterKey(1, 'End', 5)).toBe(4)
    expect(cursorAfterKey(1, 'Escape', 5)).toBeNull()
  })

  it('other_keys_and_empty_charts_are_left_alone', () => {
    expect(cursorAfterKey(1, 'Tab', 3)).toBeUndefined()
    expect(cursorAfterKey(null, 'ArrowRight', 0)).toBeUndefined()
  })
})

describe('tooltip content', () => {
  it('text_reads_heading_series_and_total', () => {
    expect(chartTooltipText(entry)).toBe('Nov 3: opus $1.20, sonnet $0.30, Total $1.50')
  })

  it('a_single_value_reads_as_just_the_value', () => {
    expect(chartTooltipText({ heading: 'Nov 3', lines: [{ label: '', value: '$1.20' }] })).toBe('Nov 3: $1.20')
  })

  it('body_shows_every_series_value_and_the_total', () => {
    const html = renderToStaticMarkup(createElement(ChartTooltipBody, { entry }))

    for (const text of ['Nov 3', 'opus', '$1.20', 'sonnet', '$0.30', 'Total', '$1.50']) expect(html).toContain(text)
  })

  it('announcement_is_empty_until_the_keyboard_moves_the_cursor', () => {
    expect(renderToStaticMarkup(createElement(ChartAnnouncement, { entry, enabled: false }))).not.toContain('Nov 3')
    expect(renderToStaticMarkup(createElement(ChartAnnouncement, { entry, enabled: true }))).toContain('Nov 3: opus $1.20')
  })
})

describe('chart plots', () => {
  const tabStops = (html: string): number => (html.match(/tabindex="0"/g) ?? []).length

  it('each_chart_is_exactly_one_tab_stop_with_arrow_key_help', () => {
    const stacked = inProvider(
      createElement(StackedBarChart, {
        title: 'Spend',
        summary: 's',
        view,
        series: [{ name: 'opus' }],
        buckets: [
          { label: 'Nov 3', values: [1] },
          { label: 'Nov 4', values: [2] }
        ],
        formatValue: String,
        bucketHeader: 'Day'
      })
    )
    const bars = inProvider(createElement(BarChart, { title: 'Mix', summary: 's', view, rows: [{ label: 'Input', value: 3 }], formatValue: String, labelHeader: 'Type' }))
    const spark = inProvider(createElement(Sparkline, { label: 'Mood', values: [1, 2, 3], labels: ['a', 'b', 'c'] }))

    expect(tabStops(stacked)).toBe(1)
    expect(tabStops(bars)).toBe(1)
    expect(tabStops(spark)).toBe(1)
    expect(stacked).toContain('Arrow keys step through the columns')
    expect(bars).toContain('Arrow keys step through the rows')
    expect(spark).toContain('Arrow keys step through the points')
  })

  it('an_empty_sparkline_is_not_a_tab_stop', () => {
    expect(tabStops(inProvider(createElement(Sparkline, { label: 'Mood', values: [] })))).toBe(0)
  })

  it('sparkline_keeps_its_summary_name', () => {
    const html = inProvider(createElement(Sparkline, { label: 'Mood', values: [1, 3] }))

    expect(html).toContain('role="img"')
    expect(html).toContain('Mood, latest 3, low 1, high 3')
  })

  it('the_table_view_has_no_plot', () => {
    const html = inProvider(
      createElement(BarChart, { title: 'Mix', summary: 's', view: { ...view, asTable: true }, rows: [{ label: 'Input', value: 3 }], formatValue: String, labelHeader: 'Type' })
    )

    expect(html).not.toContain('Arrow keys')
    expect(html).toContain('Input')
  })
})
