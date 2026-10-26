// Spec 004 FR-003, FR-033, FR-034 (issue #1082): the Context usage readout, moved out of
// ReadoutChips.tsx (at the 600-line cap) when the gradient and bar were added. The figures and
// the 90%+ word "high" take one colour from an OKLCH blend of the per-theme
// `--context-usage-0/-30/-70/-100` tokens (globals.css); `check:theme-contrast` holds every 10%
// step at 4.5:1 (`scripts/context-usage-contrast.mjs`, the same blend). The gauge icon and
// "Not available" stay muted. In forced-colors mode the browser drops the colour, and the icon
// and word carry the state.
import type { CSSProperties } from 'react'
import { GaugeIcon, TriangleAlertIcon } from 'lucide-react'
import { compactNumber } from '@/lib/compactNumber'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { ReadoutChip } from './ReadoutChip'

// Full, un-abbreviated figures for the `sr-only` phrase below (gate round 4, #437 LOW): the
// visible text abbreviates past 1,000 via `compactNumber`, but "7,500" is unambiguous read aloud.
const FULL_NUMBER_FORMAT = new Intl.NumberFormat()

const STOPS = [0, 30, 70, 100] as const

/** The CSS colour for `percent` (0-100): `color-mix(in oklch, ...)` between the two stops either
 * side, so a theme tunes the stops without a code change. */
export function contextUsageColor(percent: number): string {
  const p = Math.min(100, Math.max(0, percent))
  const upper = STOPS.findIndex((stop) => stop >= p && stop > 0)
  const lo = STOPS[upper - 1]!
  const hi = STOPS[upper]!
  const share = ((p - lo) / (hi - lo)) * 100
  return `color-mix(in oklch, var(--context-usage-${lo}), var(--context-usage-${hi}) ${share.toFixed(1)}%)`
}

/** FR-003: "N/M (P%)" (each figure abbreviated by `compactNumber`, issue #437), hidden when
 * `null`, "Not available" for the `'not-available'` literal, a visible warning (icon + the word
 * "high", never colour alone) once the rounded `percent >= 90`. The full wording reaches
 * assistive technology through a real `sr-only` span next to the `aria-hidden` visual text. */
export function ContextUsageChip({ sessionId }: { sessionId: string }) {
  const contextUsage = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.contextUsage)
  const showBar = useSettingsStore((s) => s.settings.showContextUsageBar !== false)
  if (contextUsage === null) return null
  if (contextUsage === 'not-available') {
    return (
      <ReadoutChip icon={GaugeIcon}>
        <span>Not available</span>
      </ReadoutChip>
    )
  }
  // Gate round 5 fix (Flow LOW): the rounded, DISPLAYED percent is what the warning (and the
  // colour) must agree with.
  const percent = Math.round(contextUsage.percent)
  const high = percent >= 90
  const colour: CSSProperties = { color: contextUsageColor(percent) }
  const used = compactNumber(contextUsage.usedTokens)
  const windowSize = compactNumber(contextUsage.windowTokens)
  const usedFull = FULL_NUMBER_FORMAT.format(contextUsage.usedTokens)
  const windowFull = FULL_NUMBER_FORMAT.format(contextUsage.windowTokens)
  return (
    <ReadoutChip icon={high ? TriangleAlertIcon : GaugeIcon} className="relative">
      <span className="sr-only">{`Context usage${high ? ' high' : ''}: ${usedFull} of ${windowFull} tokens used, ${percent} percent`}</span>
      <span aria-hidden data-context-usage-figures style={colour}>
        {used}/{windowSize} ({percent}%)
        {high && <span> high</span>}
      </span>
      {showBar && (
        <span aria-hidden data-context-usage-bar className="absolute inset-x-0 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-muted forced-colors:hidden">
          <span
            className="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: contextUsageColor(percent) }}
          />
        </span>
      )}
    </ReadoutChip>
  )
}
