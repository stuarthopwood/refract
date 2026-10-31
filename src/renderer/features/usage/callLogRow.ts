// One model call as a compact-list row, shared by every narrow call list. `extraCaption` lets a
// caller append a second fact (for example an advisor note) without forking the row.
import type { CompactListItem } from '@/components/CompactList'
import type { UsageCallRow } from '../../../shared/ipc-usage'
import { formatCompact, formatDateTime, formatUsd } from './format'

export function callToListItem(row: UsageCallRow, extraCaption?: string): CompactListItem {
  const caption = [formatDateTime(row.ts), `${formatCompact(row.totalTokens)} tokens`, extraCaption].filter(Boolean).join(' · ')
  return {
    key: `${row.sessionId}:${row.ts}:${row.model}:${row.totalTokens}`,
    label: row.model,
    caption,
    value: formatUsd(row.usd)
  }
}
