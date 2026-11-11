// Spec 060 S2-12: the breakdown tables, one component per table, each on the shared
// `SortableTable`. Project paths, model ids and tool names are untrusted text and render as text.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SortableTable, sortRowsBy } from '@/components/SortableTable'
import type { SortableColumn } from '@/components/SortableTable'
import { ScreenSection } from '@/components/ScreenSection'
import { useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { UsageBreakdownRow, UsageTopSession } from '../../../shared/ipc-usage'
import { costShareSortValue, formatCompact, formatInt, formatPercent, formatUsd } from './format'
import { NoData } from './NoData'

type Sort = { key: string; dir: 'asc' | 'desc' }

const credits = (value: number): string => (value > 0 ? formatInt(value) : 'n/a')

function useTable<T>(columns: SortableColumn<T>[], rows: T[], initial: Sort) {
  const [sort, setSort] = useState<Sort>(initial)
  return { sort, onSortChange: setSort, rows: sortRowsBy(rows, columns, sort) }
}

const COMMON_COLUMNS: SortableColumn<UsageBreakdownRow>[] = [
  { key: 'calls', header: 'Calls', align: 'right', sortValue: (r) => r.calls, render: (r) => formatInt(r.calls) },
  { key: 'tokens', header: 'Tokens', align: 'right', sortValue: (r) => r.tokens, render: (r) => formatCompact(r.tokens) },
  { key: 'usd', header: 'USD', align: 'right', sortValue: (r) => r.usd, render: (r) => formatUsd(r.usd) },
  { key: 'credits', header: 'AI credits', align: 'right', sortValue: (r) => r.credits, render: (r) => credits(r.credits) }
]

const PROJECT_COLUMNS: SortableColumn<UsageBreakdownRow>[] = [
  { key: 'label', header: 'Project', sortValue: (r) => r.label, render: (r) => r.label },
  ...COMMON_COLUMNS
]

const MODEL_COLUMNS: SortableColumn<UsageBreakdownRow>[] = [
  { key: 'label', header: 'Model', sortValue: (r) => r.label, render: (r) => r.label },
  { key: 'reasoning', header: 'Reasoning', sortValue: (r) => r.reasoning ?? '', render: (r) => r.reasoning || 'none' },
  ...COMMON_COLUMNS
]

const TOOL_COLUMNS: SortableColumn<UsageBreakdownRow>[] = [
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

interface BreakdownProps {
  rows: UsageBreakdownRow[]
  loading?: boolean
}

function BreakdownTable({ title, columns, rows, emptyText, loading }: BreakdownProps & { title: string; columns: SortableColumn<UsageBreakdownRow>[]; emptyText: string }) {
  const table = useTable(columns, rows, { key: columns.some((c) => c.key === 'usd') ? 'usd' : 'calls', dir: 'desc' })
  return (
    <ScreenSection title={title} count={rows.length} loading={loading}>
      <SortableTable
        caption={title}
        columns={columns}
        rows={table.rows}
        rowKey={(r) => `${r.label}\u0000${r.reasoning ?? ''}`}
        sort={table.sort}
        onSortChange={table.onSortChange}
        emptyText={emptyText}
      />
    </ScreenSection>
  )
}

export const ProjectTable = ({ rows, loading }: BreakdownProps) => (
  <BreakdownTable title="By project" columns={PROJECT_COLUMNS} rows={rows} loading={loading} emptyText="No projects in this range." />
)
export const ModelTable = ({ rows, loading }: BreakdownProps) => (
  <BreakdownTable title="By model and reasoning level" columns={MODEL_COLUMNS} rows={rows} loading={loading} emptyText="No model calls in this range." />
)
export const ToolTable = ({ rows, loading }: BreakdownProps) => (
  <BreakdownTable title="By tool" columns={TOOL_COLUMNS} rows={rows} loading={loading} emptyText="No tool calls in this range." />
)

/** Opens the Session when Refract knows it; otherwise the label is plain text (FR-014). */
function SessionLabel({ row }: { row: UsageTopSession }) {
  const known = useSessionsStore((s) => row.conversationKnown && s.sessions.some((session) => session.id === row.sessionId))
  if (!known) return <>{row.label}</>
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto min-h-0 p-0"
      onClick={() => {
        useSplitStore.getState().replaceFocused(row.sessionId)
        useViewStore.getState().openChat()
      }}
    >
      {row.label}
    </Button>
  )
}

const TOP_COLUMNS: SortableColumn<UsageTopSession>[] = [
  { key: 'label', header: 'Session', sortValue: (r) => r.label, render: (r) => <SessionLabel row={r} /> },
  { key: 'project', header: 'Project', sortValue: (r) => r.project, render: (r) => r.project },
  { key: 'calls', header: 'Calls', align: 'right', sortValue: (r) => r.calls, render: (r) => formatInt(r.calls) },
  { key: 'usd', header: 'USD', align: 'right', sortValue: (r) => r.usd, render: (r) => formatUsd(r.usd) },
  { key: 'credits', header: 'AI credits', align: 'right', sortValue: (r) => r.credits, render: (r) => credits(r.credits) }
]

export function TopSessionsTable({ rows, loading }: { rows: UsageTopSession[]; loading?: boolean }) {
  const table = useTable(TOP_COLUMNS, rows, { key: 'usd', dir: 'desc' })
  return (
    <ScreenSection title="Top ten sessions" count={rows.length} loading={loading}>
      <SortableTable
        caption="Top ten sessions by spend"
        columns={TOP_COLUMNS}
        rows={table.rows}
        rowKey={(r) => r.sessionId}
        sort={table.sort}
        onSortChange={table.onSortChange}
        emptyText="No sessions in this range."
      />
    </ScreenSection>
  )
}
