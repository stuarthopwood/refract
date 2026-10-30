// Spec 060 S2-11: the token mix, one bar per token type with its cost share beside it.
import { ScreenSection } from '@/components/ScreenSection'
import { BarChart, useChartView } from '@/components/ui/chart'
import type { UsageTokenMixRow } from '../../../shared/ipc-usage'
import { formatCompact, formatPercent } from './format'

const LABELS: Record<UsageTokenMixRow['type'], string> = {
  input: 'Input',
  cacheWrite: 'Cache write',
  cacheRead: 'Cache read',
  output: 'Output'
}

export function TokenMixChart({ rows, loading }: { rows: UsageTokenMixRow[]; loading?: boolean }) {
  const view = useChartView()
  return (
    <ScreenSection
      title="Token mix"
      loading={loading}
      empty={rows.length === 0 ? 'No tokens in this range.' : null}
      actions={view.toggle}
    >
      <BarChart
        title="Token mix"
        view={view}
        summary={`Tokens by type: ${rows.map((r) => `${LABELS[r.type]} ${formatCompact(r.tokens)}, ${formatPercent(r.costShare)} of cost`).join('; ')}.`}
        rows={rows.map((r) => ({ label: LABELS[r.type], value: r.tokens, detail: `${formatPercent(r.costShare)} of cost` }))}
        formatValue={formatCompact}
        labelHeader="Token type"
        detailHeader="Cost share"
      />
    </ScreenSection>
  )
}
