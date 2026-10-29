// Issue #1268 (spec 004 FR-050 to FR-053, split from the Context usage readout): the session's AI
// credits, its own status line chip driven only by the "Show AI credits" setting and the credits
// the Session reports (never by the context usage readout). A real `<button>` like `AdvisorChip`
// so it is keyboard-reachable without a made-up `role`; it does nothing on activation, the
// tooltip carries the plan figure. The accessible name states the credits and the plan figure, so
// a screen reader reads it as one phrase on focus.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSettingsStore } from '@/state'
import { FULL_NUMBER_FORMAT } from './ContextUsageChip'
import { READOUT_CHIP_BASE_CLASS, READOUT_CHIP_INTERACTIVE_ADDITIONS } from './ReadoutChip'
import { useCopilotPlanUsage } from './useCopilotPlanUsage'
import { cn } from '@/lib/utils'

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

export function AiCreditsChip({ sessionId }: { sessionId: string }) {
  const aiCredits = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.aiCredits ?? null)
  const creditsOn = useSettingsStore((s) => s.settings.showAiCredits !== false)
  const visible = creditsOn && aiCredits !== null
  const planUsed = useCopilotPlanUsage(visible, aiCredits)
  if (!visible) return null
  const planHigh = typeof planUsed === 'number' && Math.round(planUsed) >= 90
  const plan = `${planText(planUsed)}${planHigh ? ' (high)' : ''}`
  const credits = creditsText(aiCredits)
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <button
          type="button"
          data-slot="readout-chip"
          data-ai-credits
          aria-label={`${credits} used this session. ${plan}`}
          className={cn(READOUT_CHIP_BASE_CLASS, READOUT_CHIP_INTERACTIVE_ADDITIONS)}
        >
          <span aria-hidden>{credits}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col">
          <span>{`${credits} used this session`}</span>
          <span data-plan-usage>{plan}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
