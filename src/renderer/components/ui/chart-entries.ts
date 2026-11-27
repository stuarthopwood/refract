// The tooltip entry each chart shows for one active column, row or point (#1882). Pure, so the
// series order, the Total line and the heading fallbacks are tested per index without rendering.
import type { ChartTooltipEntry } from '@/components/ui/chart-tooltip'

/** One stacked column: a line per series in series order, then a strong Total of every value in the column. */
export function stackedEntry(
  bucket: { label: string; values: number[] },
  series: { name: string }[],
  formatValue: (value: number) => string
): ChartTooltipEntry {
  const total = bucket.values.reduce((sum, v) => sum + v, 0)
  return {
    heading: bucket.label,
    lines: [
      ...series.map((s, i) => ({ label: s.name, value: formatValue(bucket.values[i] ?? 0) })),
      { label: 'Total', value: formatValue(total), strong: true }
    ]
  }
}

/** One bar row: its value, then its detail text when it has one. */
export function barEntry(row: { label: string; value: number; detail?: string }, formatValue: (value: number) => string): ChartTooltipEntry {
  return {
    heading: row.label,
    lines: [{ label: '', value: formatValue(row.value) }, ...(row.detail !== undefined ? [{ label: '', value: row.detail }] : [])]
  }
}

/** One sparkline point; a missing label reads "Point N". Null when the index has no value. */
export function sparklineEntry(
  index: number,
  values: number[],
  labels: string[] | undefined,
  formatValue: (value: number) => string
): ChartTooltipEntry | null {
  const value = values[index]
  if (value === undefined) return null
  return { heading: labels?.[index] ?? `Point ${index + 1}`, lines: [{ label: '', value: formatValue(value) }] }
}
