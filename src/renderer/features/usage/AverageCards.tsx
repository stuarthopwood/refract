// Issue #1636: per-day, per-call and per-Session averages plus a month projection, under the
// headline cards. Figures come from `computeAverages`; no jokes here.
import { ScreenSection } from '@/components/ScreenSection'
import { StatCard } from '@/components/StatCard'
import type { UsageSummary } from '../../../shared/ipc-usage'
import { computeAverages } from './averages'
import { formatInt, formatUsd, formatUsdPerCall } from './format'

const plural = (n: number, noun: string): string => `${formatInt(n)} ${noun}${n === 1 ? '' : 's'}`

function value(n: number | null, format: (v: number) => string) {
  return n === null ? (
    <span role="img" aria-label="No data">
      -
    </span>
  ) : (
    format(n)
  )
}

export function AverageCards({ summary, loading }: { summary: UsageSummary | null; loading: boolean }) {
  const a = summary ? computeAverages(summary, new Date()) : null
  const days = summary ? `Over ${plural(summary.activeDays, 'active day')}` : undefined
  return (
    <ScreenSection title="Averages" loading={loading}>
      {summary && a && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
          <StatCard label="Avg spend per day" value={value(a.spendPerDay, formatUsd)} caption={days} />
          <StatCard
            label="Avg credits per day"
            value={value(a.creditsPerDay, formatInt)}
            caption={`${days} · Copilot models only`}
          />
          <StatCard label="Avg calls per day" value={value(a.callsPerDay, formatInt)} caption={days} />
          <StatCard label="Avg spend per call" value={value(a.spendPerCall, formatUsdPerCall)} caption={`Over ${plural(summary.calls, 'call')}`} />
          <StatCard
            label="Avg spend per Session"
            value={value(a.spendPerSession, formatUsd)}
            caption={`Over ${plural(summary.sessions, 'Session')}`}
          />
          <StatCard label="Projected month spend" value={value(a.projectedMonth, formatUsd)} caption="This month, ignores the date range" />
        </div>
      )}
    </ScreenSection>
  )
}
