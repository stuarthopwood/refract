// The Overview's Checks section (spec 038 FR-011, FR-012): the overall state, then the checks
// grouped by outcome -- only Action required and Failing expanded; Pending, Successful, Neutral
// and Skipped collapsed. Every row pairs its status icon with the outcome word (never colour
// alone) and offers "Open details" through a plain http(s) anchor, as ChangesTab does (no IPC).
import { ChevronRightIcon, CircleAlertIcon, ExternalLinkIcon, MinusCircleIcon, SkipForwardIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { RowKebabMenu } from '@/components/RowKebabMenu'
import type { RowMenuEntry } from '@/components/RowKebabMenu'
import { cn } from '@/lib/utils'
import type { CheckOutcome, PullRequestCheck, PullRequestDetail } from '../../../shared/github'
import { CHECK_STATE_DISPLAY } from './PullRequestRow'

interface OutcomeDisplay {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  label: string
  colorClass: string
}

const CHECK_OUTCOME_DISPLAY: Record<CheckOutcome, OutcomeDisplay> = {
  'action-required': { icon: CircleAlertIcon, label: 'Action required', colorClass: CHECK_STATE_DISPLAY.failed.colorClass },
  failing: { ...CHECK_STATE_DISPLAY.failed, label: 'Failing' },
  pending: { ...CHECK_STATE_DISPLAY.pending, label: 'Pending' },
  successful: { ...CHECK_STATE_DISPLAY.passed, label: 'Successful' },
  neutral: { icon: MinusCircleIcon, label: 'Neutral', colorClass: CHECK_STATE_DISPLAY.none.colorClass },
  skipped: { icon: SkipForwardIcon, label: 'Skipped', colorClass: CHECK_STATE_DISPLAY.none.colorClass }
}

const GROUPS: { outcome: CheckOutcome; defaultOpen: boolean }[] = [
  { outcome: 'action-required', defaultOpen: true },
  { outcome: 'failing', defaultOpen: true },
  { outcome: 'pending', defaultOpen: false },
  { outcome: 'successful', defaultOpen: false },
  { outcome: 'neutral', defaultOpen: false },
  { outcome: 'skipped', defaultOpen: false }
]

/** "12s", "2m 5s", "0s"; empty when either end is unknown. */
export function formatCheckDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return ''
  const seconds = Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m ${seconds % 60}s`
  return `${hours}h ${minutes % 60}m`
}

function isHttpUrl(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url)
}

function CheckRow({ check }: { check: PullRequestCheck }) {
  const display = CHECK_OUTCOME_DISPLAY[check.outcome]
  const Icon = display.icon
  const duration = formatCheckDuration(check.startedAt, check.completedAt)
  const entries: RowMenuEntry[] = isHttpUrl(check.detailsUrl)
    ? [{ id: 'details', label: 'Open details', icon: ExternalLinkIcon, href: check.detailsUrl }]
    : [{ id: 'details', label: 'Open details (no link available)', icon: ExternalLinkIcon, disabled: true }]
  return (
    <li className="py-1 pl-6 text-sm">
      <RowKebabMenu entries={entries} label={`Actions for ${check.name}`}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn('flex shrink-0 items-center gap-1 text-xs', display.colorClass)}>
            <Icon aria-hidden className={cn('size-4', check.outcome === 'pending' && 'animate-spin')} />
            {display.label}
          </span>
          <span className="min-w-0 flex-1 truncate">{check.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{duration}</span>
        </div>
      </RowKebabMenu>
    </li>
  )
}

export function ChecksSection({ checks, checkState }: { checks: PullRequestDetail['checks']; checkState: PullRequestDetail['checkState'] }) {
  if (checks.length === 0) return null
  const overall = CHECK_STATE_DISPLAY[checkState]
  const OverallIcon = overall.icon
  return (
    <section aria-label="Checks" className="px-4 pt-2 pb-4">
      <h3 className={cn('mb-2 flex items-center gap-2 text-base font-semibold', overall.colorClass)}>
        <OverallIcon aria-hidden className={cn('size-4', checkState === 'pending' && 'animate-spin')} />
        {overall.label}
      </h3>
      {GROUPS.map(({ outcome, defaultOpen }) => {
        const rows = checks.filter((check) => check.outcome === outcome)
        if (rows.length === 0) return null
        return (
          <Collapsible key={outcome} defaultOpen={defaultOpen}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-sm py-1 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              <ChevronRightIcon aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-90" />
              {CHECK_OUTCOME_DISPLAY[outcome].label} ({rows.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul>
                {rows.map((check, i) => (
                  <CheckRow key={`${check.name}-${i}`} check={check} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </section>
  )
}
