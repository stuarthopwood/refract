// Spec 060 S2-09: the budget card. A Copilot row (plan usage bar, burn-rate line), one row per
// other provider, or "Budget unavailable" with the reason. Provider labels come from OMP and
// render as plain text only.
import { ProgressStrip } from '@/components/ProgressStrip'
import { ScreenSection } from '@/components/ScreenSection'
import type { UsageBudget } from '../../../shared/ipc-usage'
import { formatInt, formatPercent } from './format'

const dateOnly = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' })

function CopilotRow({ copilot, jokes }: { copilot: NonNullable<UsageBudget['copilot']>; jokes: boolean }) {
  const { percentUsed, creditsUsed, entitlement, remaining, resetsAt, burnPerDay, capDate } = copilot
  const detail =
    creditsUsed !== null && entitlement !== null
      ? `${formatInt(creditsUsed)} of ${formatInt(entitlement)} AI credits used`
      : `${formatPercent(percentUsed / 100)} of the plan used`
  return (
    <div className="flex flex-col gap-1">
      <ProgressStrip
        value={Math.round(percentUsed)}
        max={100}
        label={`Copilot: ${detail}${remaining !== null ? `, ${formatInt(remaining)} left` : ''}`}
        doneText="The Copilot plan is fully used."
      />
      <p className="text-xs text-muted-foreground">
        Resets {dateOnly(resetsAt)}.
        {burnPerDay !== null && ` Burning about ${formatInt(burnPerDay)} credits a day.`}
        {capDate !== null && ` At that pace the plan runs out on ${dateOnly(capDate)}.`}
        {jokes && burnPerDay !== null && capDate === null && ' Comfortably inside the allowance.'}
      </p>
    </div>
  )
}

export function BudgetCard({ budget, jokes }: { budget: UsageBudget | null; jokes: boolean }) {
  const empty = !budget || (!budget.copilot && budget.providers.length === 0)
  return (
    <ScreenSection
      title="Budget"
      loading={budget === null}
      empty={budget && empty ? `Budget unavailable${budget.unavailable ? `: ${budget.unavailable}` : ''}.` : null}
    >
      {budget && !empty && (
        <div className="flex flex-col gap-4 rounded-lg border p-4">
          {budget.copilot && <CopilotRow copilot={budget.copilot} jokes={jokes} />}
          {budget.unavailable && <p className="text-xs text-muted-foreground">Budget unavailable for some providers: {budget.unavailable}.</p>}
          {budget.providers.map((provider) => (
            <div key={`${provider.provider}-${provider.label}`} className="flex flex-col gap-1">
              {provider.limit !== null ? (
                <ProgressStrip
                  value={provider.used}
                  max={provider.limit}
                  label={`${provider.label}: ${formatInt(provider.used)} of ${formatInt(provider.limit)} ${provider.unit}`}
                  doneText={`${provider.label} is fully used.`}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {provider.label}: {formatInt(provider.used)} {provider.unit} used
                </p>
              )}
              {provider.resetsAt !== null && <p className="text-xs text-muted-foreground">Resets {dateOnly(provider.resetsAt)}.</p>}
            </div>
          ))}
        </div>
      )}
    </ScreenSection>
  )
}
