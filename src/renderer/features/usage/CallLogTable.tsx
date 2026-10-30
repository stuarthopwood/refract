// Spec 060 S2-12: the per-call log. Sort and paging are server side (`usage.calls`), so the
// shared `SortableTable` is controlled by the store. No prompt text exists in a row (FR-015).
import { useEffect } from 'react'
import { SortableTable } from '@/components/SortableTable'
import type { SortableColumn } from '@/components/SortableTable'
import { ScreenSection } from '@/components/ScreenSection'
import { CALLS_PAGE_SIZE, useUsageStore } from '@/state/usage-store'
import { useTokenGuardStore } from '@/state/token-guard-store'
import type { UsageCallRow, UsageCallSortKey } from '../../../shared/ipc-usage'
import { formatCompact, formatDateTime, formatDuration, formatInt, formatUsd } from './format'

// #1409: an advisor call on a model other than the Advisor role came from a WATCHDOG.yml roster.
function AgentCell({ row }: { row: UsageCallRow }) {
  const loaded = useTokenGuardStore((s) => s.loaded)
  const role = useTokenGuardStore((s) => s.values['modelRoles.advisor'] ?? s.defaults['modelRoles.advisor'])
  const roleModel = typeof role === 'string' ? (role.split(':')[0] ?? '') : ''
  const differs = loaded && row.agentType === 'advisor' && row.model !== roleModel && !roleModel.endsWith(`/${row.model}`)
  return (
    <>
      {row.agentType}
      {differs && <span className="block text-xs text-muted-foreground">Advisor (WATCHDOG.yml roster)</span>}
    </>
  )
}

const COLUMNS: SortableColumn<UsageCallRow>[] = [
  { key: 'ts', header: 'Time', sortValue: (r) => r.ts, render: (r) => formatDateTime(r.ts) },
  { key: 'project', header: 'Project', sortValue: (r) => r.project, render: (r) => r.project },
  { key: 'model', header: 'Model', sortValue: (r) => r.model, render: (r) => r.model },
  { key: 'reasoning', header: 'Reasoning', render: (r) => r.reasoning || 'none' },
  { key: 'agentType', header: 'Agent', render: (r) => <AgentCell row={r} /> },
  { key: 'tokens', header: 'Tokens', align: 'right', sortValue: (r) => r.totalTokens, render: (r) => formatCompact(r.totalTokens) },
  { key: 'usd', header: 'USD', align: 'right', sortValue: (r) => r.usd, render: (r) => formatUsd(r.usd) },
  { key: 'credits', header: 'AI credits', align: 'right', sortValue: (r) => r.credits ?? 0, render: (r) => (r.credits === null ? 'n/a' : formatInt(r.credits)) },
  { key: 'duration', header: 'Duration', align: 'right', sortValue: (r) => r.durationMs ?? 0, render: (r) => formatDuration(r.durationMs) }
]

export function CallLogTable({ loading }: { loading?: boolean }) {
  const loadRoles = useTokenGuardStore((s) => s.load)
  const rolesLoaded = useTokenGuardStore((s) => s.loaded)
  useEffect(() => {
    if (!rolesLoaded) void loadRoles()
  }, [rolesLoaded, loadRoles])
  const calls = useUsageStore((s) => s.calls)
  const setSort = useUsageStore((s) => s.setCallsSort)
  const setPage = useUsageStore((s) => s.setCallsPage)
  return (
    <ScreenSection title="Call log" count={calls.total} loading={loading}>
      <SortableTable
        caption="Model calls, one row per call"
        columns={COLUMNS}
        rows={calls.rows}
        rowKey={(r) => `${r.sessionId}:${r.ts}:${r.model}:${r.totalTokens}`}
        sort={calls.sort}
        onSortChange={(sort) => setSort({ key: sort.key as UsageCallSortKey, dir: sort.dir })}
        emptyText="No model calls in this range."
        paging={{ index: calls.pageIndex, size: CALLS_PAGE_SIZE, total: calls.total, onIndexChange: setPage }}
      />
    </ScreenSection>
  )
}
