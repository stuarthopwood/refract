import { describe, expect, it } from 'vitest'
import { barEntry, sparklineEntry, stackedEntry } from './chart-entries'

const usd = (n: number): string => `$${n.toFixed(2)}`
const series = [{ name: 'opus' }, { name: 'sonnet' }, { name: 'Other' }]
const buckets = [
  { label: 'Nov 3', values: [1.2, 0.3, 0] },
  { label: 'Nov 4', values: [0, 2, 0.5] }
]

describe('stackedEntry', () => {
  it('heads_each_column_with_its_own_label', () => {
    expect(buckets.map((b) => stackedEntry(b, series, usd).heading)).toEqual(['Nov 3', 'Nov 4'])
  })

  it('lists_a_line_per_series_in_series_order_with_that_columns_values', () => {
    const lines = buckets.map((b) => stackedEntry(b, series, usd).lines.slice(0, series.length))

    expect(lines[0]).toEqual([
      { label: 'opus', value: '$1.20' },
      { label: 'sonnet', value: '$0.30' },
      { label: 'Other', value: '$0.00' }
    ])
    expect(lines[1]?.map((l) => l.value)).toEqual(['$0.00', '$2.00', '$0.50'])
  })

  it('ends_with_a_strong_total_of_the_columns_values', () => {
    expect(buckets.map((b) => stackedEntry(b, series, usd).lines.at(-1))).toEqual([
      { label: 'Total', value: '$1.50', strong: true },
      { label: 'Total', value: '$2.50', strong: true }
    ])
  })

  it('reads_a_missing_value_as_zero', () => {
    expect(stackedEntry({ label: 'Nov 5', values: [4] }, series, usd).lines.map((l) => l.value)).toEqual(['$4.00', '$0.00', '$0.00', '$4.00'])
  })
})

describe('barEntry', () => {
  it('shows_the_value_under_the_row_label', () => {
    expect(barEntry({ label: 'Input', value: 3 }, usd)).toEqual({ heading: 'Input', lines: [{ label: '', value: '$3.00' }] })
  })

  it('adds_the_detail_as_a_second_line_when_the_row_has_one', () => {
    expect(barEntry({ label: 'Cache', value: 3, detail: '40% of input' }, usd).lines).toEqual([
      { label: '', value: '$3.00' },
      { label: '', value: '40% of input' }
    ])
  })

  it('keeps_an_empty_detail_line', () => {
    expect(barEntry({ label: 'Cache', value: 3, detail: '' }, usd).lines).toHaveLength(2)
  })
})

describe('sparklineEntry', () => {
  const values = [1, 2, 3]

  it('maps_each_index_to_its_own_label_and_value', () => {
    const labels = ['a', 'b', 'c']

    expect(values.map((_, i) => sparklineEntry(i, values, labels, usd))).toEqual([
      { heading: 'a', lines: [{ label: '', value: '$1.00' }] },
      { heading: 'b', lines: [{ label: '', value: '$2.00' }] },
      { heading: 'c', lines: [{ label: '', value: '$3.00' }] }
    ])
  })

  it('falls_back_to_one_based_point_numbers_without_labels', () => {
    expect(values.map((_, i) => sparklineEntry(i, values, undefined, usd)?.heading)).toEqual(['Point 1', 'Point 2', 'Point 3'])
  })

  it('falls_back_only_for_the_index_the_labels_do_not_cover', () => {
    expect(values.map((_, i) => sparklineEntry(i, values, ['a'], usd)?.heading)).toEqual(['a', 'Point 2', 'Point 3'])
  })

  it('has_no_entry_for_an_index_without_a_value', () => {
    expect(sparklineEntry(3, values, undefined, usd)).toBeNull()
  })
})
