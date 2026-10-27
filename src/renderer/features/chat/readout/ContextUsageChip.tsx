// Spec 004 FR-003, FR-033, FR-034 (issue #1082): the Context usage readout, moved out of
// ReadoutChips.tsx (at the 600-line cap) when the gradient and bar were added. The figures and
// the 90%+ word "high" take one colour from an OKLCH blend of the per-theme
// `--context-usage-0/-30/-70/-100` tokens (globals.css); `check:theme-contrast` holds every 10%
// step at 4.5:1 (`scripts/context-usage-contrast.mjs`, the same blend). The gauge icon and
// "Not available" stay muted. In forced-colors mode the browser drops the colour, and the icon
// and word carry the state.
import type { CSSProperties } from 'react'
import { GaugeIcon, TriangleAlertIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { compactNumber } from '@/lib/compactNumber'
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { READOUT_CHIP_INTERACTIVE_ADDITIONS, ReadoutChip } from './ReadoutChip'
import { useCopilotPlanUsage } from './useCopilotPlanUsage'

/** #1238 (FR-050): "12 credits", "1 credit", "<1 credit" for a tiny non-zero spend. */
function creditsText(credits: number): string {
  const whole = Math.round(credits)
  if (whole < 1) return credits > 0 ? '<1 credit' : '0 credits'
  return `${FULL_NUMBER_FORMAT.format(whole)} ${whole === 1 ? 'credit' : 'credits'}`
}

/** The plan figure; `undefined` = still loading, `null` = the lookup reported nothing. */
function planText(percentUsed: number | null | undefined): string {
  if (percentUsed === undefined) return 'Checking plan usage…'
  if (percentUsed === null) return 'Plan usage unavailable'
  return percentUsed > 0 && percentUsed < 1 ? 'Plan: <1% used' : `Plan: ${Math.round(percentUsed)}% used`
}

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
  const aiCredits = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.aiCredits ?? null)
  const creditsOn = useSettingsStore((s) => s.settings.showAiCredits !== false)
  const planUsed = useCopilotPlanUsage(creditsOn && aiCredits !== null, aiCredits)
  if (contextUsage === null) return null
  const planHigh = typeof planUsed === 'number' && Math.round(planUsed) >= 90
  const creditsLabel = aiCredits === null ? '' : `${creditsText(aiCredits)} used this session. ${planText(planUsed)}${planHigh ? ' (high)' : ''}`
  const credits = creditsOn && aiCredits !== null && (
    <>
      <span aria-hidden>·</span>
      <Tooltip>
        <TooltipTrigger asChild aria-describedby={undefined}>
          <span
            tabIndex={0}
            role="group"
            aria-label={creditsLabel}
            data-ai-credits
            className={cn('outline-none focus-visible:outline-solid', READOUT_CHIP_INTERACTIVE_ADDITIONS)}
          >
            <span aria-hidden>{creditsText(aiCredits)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <span className="flex flex-col">
            <span>{`${creditsText(aiCredits)} used this session`}</span>
            <span data-plan-usage>
              {planText(planUsed)}
              {planHigh && ' (high)'}
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
    </>
  )
  if (contextUsage === 'not-available') {
    return (
      <ReadoutChip icon={GaugeIcon}>
        <span aria-hidden>Context n/a</span>
        <span className="sr-only">Context usage not available</span>
        {credits}
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
      {credits}
    </ReadoutChip>
  )
}
