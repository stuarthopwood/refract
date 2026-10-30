// Spec 060 S2-10: the eight headline cards. Spend is USD (the only unit every provider shares);
// AI credits are Copilot-only, so the credits card says so rather than showing a misleading zero.
import { StatCard } from '@/components/StatCard'
import type { UsageSummary } from '../../../shared/ipc-usage'
import { summaryCaptions } from './captions'
import { formatCompact, formatInt, formatPercent, formatUsd } from './format'

export function HeadlineCards({ summary, jokes }: { summary: UsageSummary; jokes: boolean }) {
  const captions = summaryCaptions(summary, jokes)
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
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
      {cards.map((card) => (
        <StatCard key={card.label} label={card.label} value={card.value} caption={card.caption} />
      ))}
    </div>
  )
}
