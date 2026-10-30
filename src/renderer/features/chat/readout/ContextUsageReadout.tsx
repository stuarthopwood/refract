import type { CSSProperties } from 'react'
import { GaugeIcon, TriangleAlertIcon } from 'lucide-react'
import { compactNumber } from '@/lib/compactNumber'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { ContextShakeMenu } from './ContextShakeMenu'
import { ReadoutItem } from './ReadoutItem'

export const FULL_NUMBER_FORMAT = new Intl.NumberFormat()

const STOPS = [0, 30, 70, 100] as const

/** `color-mix` between the stops either side of `percent`, so a theme tunes stops without code. */
export function contextUsageColor(percent: number): string {
  const p = Math.min(100, Math.max(0, percent))
  const upper = STOPS.findIndex((stop) => stop >= p && stop > 0)
  const lo = STOPS[upper - 1]!
  const hi = STOPS[upper]!
  const share = ((p - lo) / (hi - lo)) * 100
  return `color-mix(in oklch, var(--context-usage-${lo}), var(--context-usage-${hi}) ${share.toFixed(1)}%)`
}

/** Shows a warning icon plus the word "high" (never colour alone) at 90% and above. */
export function ContextUsageReadout({ sessionId }: { sessionId: string }) {
  const contextUsage = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.contextUsage)
  const showBar = useSettingsStore((s) => s.settings.showContextUsageBar !== false)
  if (contextUsage === null) return null
  if (contextUsage === 'not-available') {
    return (
      <ContextShakeMenu sessionId={sessionId} figure={null}>
        <ReadoutItem icon={GaugeIcon} accessibleName="Context n/a, context usage, shake options">
          <span aria-hidden>Context n/a</span>
        </ReadoutItem>
      </ContextShakeMenu>
    )
  }
  const percent = Math.round(contextUsage.percent)
  const high = percent >= 90
  const colour: CSSProperties = { color: contextUsageColor(percent) }
  const used = compactNumber(contextUsage.usedTokens)
  const windowSize = compactNumber(contextUsage.windowTokens)
  const usedFull = FULL_NUMBER_FORMAT.format(contextUsage.usedTokens)
  const windowFull = FULL_NUMBER_FORMAT.format(contextUsage.windowTokens)
  return (
    <ContextShakeMenu sessionId={sessionId} figure={`${used}/${windowSize} (${percent}%)`}>
      <ReadoutItem
        icon={high ? TriangleAlertIcon : GaugeIcon}
        accessibleName={`${used}/${windowSize} (${percent}%)${high ? ' high' : ''}, ${usedFull} of ${windowFull} tokens used, context usage, shake options`}
      >
        <span aria-hidden data-context-usage-figures style={colour} className="relative inline-flex items-center self-stretch">
          {used}/{windowSize} ({percent}%)
          {high && <span> high</span>}
          {showBar && (
            <span aria-hidden data-context-usage-bar className="absolute inset-x-0 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-muted forced-colors:hidden">
              <span
                className="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300"
                style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: contextUsageColor(percent) }}
              />
            </span>
          )}
        </span>
      </ReadoutItem>
    </ContextShakeMenu>
  )
}
