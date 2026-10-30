// Spec 060 S2-11: the token mix, one bar per token type with its cost share beside it.
import { BarChart } from '@/components/ui/chart'
import type { UsageTokenMixRow } from '../../../shared/ipc-usage'
import { formatCompact, formatPercent } from './format'

const LABELS: Record<UsageTokenMixRow['type'], string> = {
  input: 'Input',
  cacheWrite: 'Cache write',
  cacheRead: 'Cache read',
  output: 'Output'
}

export function TokenMixChart({ rows }: { rows: UsageTokenMixRow[] }) {
  return (
    <BarChart
      title="Token mix"
      summary={`Tokens by type: ${rows.map((r) => `${LABELS[r.type]} ${formatCompact(r.tokens)}, ${formatPercent(r.costShare)} of cost`).join('; ')}.`}
      rows={rows.map((r) => ({ label: LABELS[r.type], value: r.tokens, detail: `${formatPercent(r.costShare)} of cost` }))}
      formatValue={formatCompact}
      detailHeader="Cost share"
    />
  )
}
