// The shared sortable table (spec 060 S2-03, ADR 0003): column headers are real buttons (keyboard
// reachable, Enter or Space sorts) inside `th` cells carrying `aria-sort`; an optional pager with
// a polite page line; one muted row when there is nothing to show. Sort is controlled: pass
// `sortRowsBy` output for client-side data, or send the sort to the server for paged data.
import type { ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// aria-disabled keeps the button focusable, so focus is not lost when the last page is reached.
const PAGER_DISABLED_CLASS = 'aria-disabled:opacity-50'

export type SortDirection = 'asc' | 'desc'

export interface SortableColumn<T> {
  key: string
  header: string
  align?: 'left' | 'right'
  /** Omit for a column that does not sort. */
  sortValue?(row: T): number | string
  render(row: T): ReactNode
}

export interface SortableTableProps<T> {
  /** Visually hidden table name. */
  caption: string
  columns: SortableColumn<T>[]
  rows: T[]
  rowKey(row: T): string
  sort: { key: string; dir: SortDirection }
  onSortChange(sort: { key: string; dir: SortDirection }): void
  emptyText: string
  /** First fetch in flight: one muted "Loading…" row instead of the empty text. */
  loading?: boolean
  paging?: { index: number; size: number; total: number; onIndexChange(index: number): void }
}

export function sortRowsBy<T>(rows: T[], columns: SortableColumn<T>[], sort: { key: string; dir: SortDirection }): T[] {
  const column = columns.find((c) => c.key === sort.key)
  if (!column?.sortValue) return rows
  const value = column.sortValue
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign
  })
}

export function SortableTable<T>({ caption, columns, rows, rowKey, sort, onSortChange, emptyText, loading = false, paging }: SortableTableProps<T>) {
  const pageCount = paging ? Math.max(1, Math.ceil(paging.total / paging.size)) : 1
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const active = column.sortValue !== undefined && sort.key === column.key
                const right = column.align === 'right'
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : column.sortValue ? 'none' : undefined}
                    className={cn('px-1 py-1 font-semibold', right ? 'text-right' : 'text-left')}
                  >
                    {column.sortValue ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="px-2 text-xs font-semibold"
                        onClick={() => onSortChange({ key: column.key, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
                      >
                        {column.header}
                        {active && (sort.dir === 'asc' ? <ArrowUpIcon aria-hidden className="size-3" /> : <ArrowDownIcon aria-hidden className="size-3" />)}
                      </Button>
                    ) : (
                      <span className="px-2">{column.header}</span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 || loading ? (
              <tr>
                <td colSpan={columns.length} className="px-2 py-4 text-muted-foreground">
                  {loading ? 'Loading…' : emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={rowKey(row)} className="border-t border-divider">
                  {columns.map((column) => (
                    <td key={column.key} className={cn('max-w-72 break-words px-2 py-1', column.align === 'right' ? 'text-right' : 'text-left')}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {paging && paging.total > paging.size && (
        <div className="flex items-center gap-2 text-xs">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-disabled={paging.index <= 0}
            className={PAGER_DISABLED_CLASS}
            onClick={() => paging.index > 0 && paging.onIndexChange(paging.index - 1)}
          >
            Previous
          </Button>
          <span aria-live="polite" className="tabular-nums text-muted-foreground">
            Page {paging.index + 1} of {pageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-disabled={paging.index + 1 >= pageCount}
            className={PAGER_DISABLED_CLASS}
            onClick={() => paging.index + 1 < pageCount && paging.onIndexChange(paging.index + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
