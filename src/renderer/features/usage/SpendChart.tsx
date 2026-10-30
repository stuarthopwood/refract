// Spec 060 S2-11: spend over time stacked by model (top four models plus "Other"), with a
// day or hour toggle built from the shared Filter tabs.
import { FilterTabs } from '@/components/FilterTabs'
import { ScreenSection } from '@/components/ScreenSection'
import { StackedBarChart, useChartView } from '@/components/ui/chart'
import type { UsageTimeBucket } from '../../../shared/ipc-usage'
import { formatBucketLabel, formatUsd } from './format'

const TOP_MODELS = 4
const OTHER = 'Other'

export function SpendChart({
  buckets,
  bucket,
  onBucketChange,
  loading
}: {
  buckets: UsageTimeBucket[]
  bucket: 'day' | 'hour'
  onBucketChange(bucket: 'day' | 'hour'): void
  loading?: boolean
}) {
  const view = useChartView(loading === true || buckets.length === 0)
  const totals = new Map<string, number>()
  for (const b of buckets) for (const m of b.byModel) totals.set(m.model, (totals.get(m.model) ?? 0) + m.usd)
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model)
  const top = ranked.slice(0, TOP_MODELS)
  const series = [...top, ...(ranked.length > TOP_MODELS ? [OTHER] : [])].map((name) => ({ name, muted: name === OTHER && !top.includes(OTHER) }))
  const rows = buckets.map((b) => {
    const values = series.map(() => 0)
    for (const m of b.byModel) {
      const index = top.indexOf(m.model)
      const at = index === -1 ? series.length - 1 : index
      values[at] = (values[at] ?? 0) + m.usd
    }
    return { label: formatBucketLabel(b.bucketStart, bucket), values }
  })
  return (
    <ScreenSection
      title="Spend over time"
      loading={loading}
      empty={buckets.length === 0 ? 'No spend in this range.' : null}
      actions={
        <>
          <FilterTabs
            ariaLabel="Spend bucket"
            tabs={[
              { value: 'day', label: 'By day' },
              { value: 'hour', label: 'By hour' }
            ]}
            value={bucket}
            onValueChange={onBucketChange}
          />
          {view.toggle}
        </>
      }
    >
      <StackedBarChart
        title="Spend over time"
        view={view}
        summary={`Spend per ${bucket}, stacked by model. ${series.map((s) => s.name).join(', ')}.`}
        series={series}
        buckets={rows}
        formatValue={formatUsd}
        bucketHeader={bucket === 'day' ? 'Day' : 'Hour'}
      />
    </ScreenSection>
  )
}
