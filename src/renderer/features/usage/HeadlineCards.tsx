// Spec 060 S2-10: the eight headline cards. Spend is USD (the only unit every provider shares);
// AI credits are Copilot-only, so the credits card says so rather than showing a misleading zero.
// `stacked` is the narrow-column layout (Session usage panel): four cards in a tight grid and the
// cache and tool-error rates on one muted line.
import { StatCard } from '@/components/StatCard'
import type { UsageSummary } from '../../../shared/ipc-usage'
import { summaryCaptions } from './captions'
import { formatCompact, formatInt, formatPercent, formatUsd, formatUsdPerCall } from './format'
import { dash } from './averages'

export function HeadlineCards({ summary, jokes, layout = 'grid' }: { summary: UsageSummary; jokes: boolean; layout?: 'grid' | 'stacked' }) {
  const captions = summaryCaptions(summary, jokes)
  const stacked = layout === 'stacked'
  const cards: Array<{ label: string; value: string; caption: string }> = [
    { label: 'Spend', value: formatUsd(summary.spendUsd), caption: captions.spend },
    { label: 'AI credits', value: formatInt(summary.credits), caption: captions.credits || 'Copilot models only' },
    { label: 'Model calls', value: formatInt(summary.calls), caption: captions.calls },
    { label: 'Total tokens', value: formatCompact(summary.totalTokens), caption: captions.tokens },
    { label: 'Cache hit rate', value: formatPercent(summary.cacheHitRate), caption: captions.cache },
    { label: 'Average context per call', value: formatCompact(summary.avgContextPerCall), caption: captions.context },
    { label: 'Tool calls', value: formatInt(summary.toolCalls), caption: captions.tools },
    { label: 'Tool error rate', value: formatPercent(summary.toolErrorRate), caption: captions.toolErrors }
  ]
  if (stacked) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2">
          {cards.slice(0, 4).map((card) => (
            <StatCard key={card.label} label={card.label} value={card.value} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Cache hit rate {formatPercent(summary.cacheHitRate)} · Tool error rate {formatPercent(summary.toolErrorRate)} · Avg spend per
          call {summary.calls > 0 ? formatUsdPerCall(summary.spendUsd / summary.calls) : dash}
        </p>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
      {cards.map((card) => (
        <StatCard key={card.label} label={card.label} value={card.value} caption={card.caption} />
      ))}
    </div>
  )
}