import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ProgressStrip } from '@/components/ProgressStrip'
import type { UsageReport, UsageRow } from '../../../shared/usageOutput'

const NEAR_LIMIT_LEFT_PERCENT = 15

function rowState(left: number | null): { state: 'ok' | 'warning' | 'error'; note: string } {
  if (left === null) return { state: 'ok', note: '' }
  if (left <= 0) return { state: 'error', note: ', limit reached' }
  if (left < NEAR_LIMIT_LEFT_PERCENT) return { state: 'warning', note: ', near the limit' }
  return { state: 'ok', note: '' }
}

function UsageRowView({ row }: { row: UsageRow }) {
  const used = `${row.used}${row.unit === '%' ? '%' : row.unit ? ` ${row.unit}` : ''} used`
  if (row.leftPercent === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {row.account}: {used}
      </p>
    )
  }
  const { state, note } = rowState(row.leftPercent)
  const left = Math.max(0, Math.min(100, row.leftPercent))
  return (
    <ProgressStrip
      value={Math.round(100 - left)}
      max={100}
      state={state}
      label={`${row.account}: ${used}, ${row.leftPercent.toFixed(1)}% left${note}`}
    />
  )
}

/** A parsed `/usage` reply: fetched-at age, then a bar per provider window and account. */
export function UsageNoticeCard({ report }: { report: UsageReport }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Usage{report.age ? ` (${report.age} ago)` : ''}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4">
        {report.groups.map((group) => (
          <section key={`${group.provider}-${group.window}`} className="flex flex-col gap-2" aria-label={group.provider}>
            <h4 className="text-xs font-medium text-foreground">
              {group.provider}
              {group.window ? <span className="font-normal text-muted-foreground"> - {group.window}</span> : null}
            </h4>
            {group.rows.map((row) => (
              <UsageRowView key={row.account} row={row} />
            ))}
          </section>
        ))}
      </CardContent>
    </Card>
  )
}
