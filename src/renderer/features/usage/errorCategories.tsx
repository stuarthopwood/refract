// Spec 060 FR-020: the "Tool errors by category" table. Kept apart from `UsageTables` so the row
// logic loads without the app stores in unit tests.
import type { SortableColumn } from '@/components/SortableTable'
import type { UsageErrorCategory, UsageErrorCategoryRow } from '../../../shared/ipc-usage'
import { formatInt, formatPercent } from './format'

export const ERROR_CATEGORY_LABELS: Record<UsageErrorCategory, string> = {
  policy: 'Blocked by policy',
  edit_rejected: 'Edit rejected',
  invalid_input: 'Invalid input',
  not_found: 'Not found',
  timeout: 'Timed out',
  aborted: 'Aborted',
  other: 'Other',
  unknown: 'Unknown (recorded before categories)'
}

export interface ErrorCategoryDisplayRow {
  category: UsageErrorCategory
  label: string
  count: number
  /** Fraction (0 to 1) of all failed calls in the window. */
  share: number
}

/** Adds each category's label and its share of failed calls; no failed call means no rows. */
export function errorCategoryDisplayRows(rows: UsageErrorCategoryRow[]): ErrorCategoryDisplayRow[] {
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (total === 0) return []
  return rows
    .filter((row) => row.count > 0)
    .map((row) => ({
      category: row.category,
      label: ERROR_CATEGORY_LABELS[row.category] ?? row.category,
      count: row.count,
      share: row.count / total
    }))
}

export const ERROR_CATEGORY_COLUMNS: SortableColumn<ErrorCategoryDisplayRow>[] = [
  { key: 'label', header: 'Category', sortValue: (r) => r.label, render: (r) => r.label },
  { key: 'count', header: 'Failed calls', align: 'right', sortValue: (r) => r.count, render: (r) => formatInt(r.count) },
  { key: 'share', header: 'Share of failures', align: 'right', sortValue: (r) => r.share, render: (r) => formatPercent(r.share) }
]
