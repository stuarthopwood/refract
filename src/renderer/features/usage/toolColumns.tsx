// Kept apart from `UsageTables` so the column logic loads without the app stores in unit tests.
import type { SortableColumn } from '@/components/SortableTable'
import type { UsageBreakdownRow } from '../../../shared/ipc-usage'
import { costShareSortValue, formatCompact, formatInt, formatPercent } from './format'
import { NoData } from './NoData'

export const TOOL_COLUMNS: SortableColumn<UsageBreakdownRow>[] = [
  { key: 'label', header: 'Tool', sortValue: (r) => r.label, render: (r) => r.label },
  { key: 'calls', header: 'Calls', align: 'right', sortValue: (r) => r.calls, render: (r) => formatInt(r.calls) },
  { key: 'errors', header: 'Errors', align: 'right', sortValue: (r) => r.errors ?? 0, render: (r) => formatInt(r.errors ?? 0) },
  {
    key: 'chars',
    header: 'Result size (characters)',
    align: 'right',
    sortValue: (r) => r.resultChars ?? 0,
    render: (r) => formatCompact(r.resultChars ?? 0)
  },
  {
    key: 'share',
    header: 'Cost share',
    align: 'right',
    sortValue: (r) => costShareSortValue(r.costShare),
    render: (r) => (r.costShare === undefined ? <NoData label="No priced calls" /> : formatPercent(r.costShare))
  }
]
