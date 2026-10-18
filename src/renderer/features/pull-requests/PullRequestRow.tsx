// One row in the pull request list (specs/003-pull-request-management FR-005, T013): title,
// number, check status (icon + text, never colour alone -- FR-030), repository, time since last
// updated, and author.
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  XCircleIcon
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { PullRequestState, PullRequestSummary } from '../../../shared/github'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { cn } from '@/lib/utils'

interface PullRequestRowProps {
  pullRequest: PullRequestSummary
  selected: boolean
  onSelect(): void
}

export interface CheckDisplay {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  label: string
}

export const CHECK_STATE_DISPLAY: Record<PullRequestSummary['checkState'], CheckDisplay> = {
  passed: { icon: CheckCircle2Icon, label: 'Checks passed' },
  failed: { icon: XCircleIcon, label: 'Checks failed' },
  pending: { icon: LoaderCircleIcon, label: 'Checks running' },
  none: { icon: CircleDashedIcon, label: 'No checks' }
}

/** High remediation (accessibility-auditor, FR-007/FR-030): open/draft/closed/merged was never
 * visibly conveyed anywhere -- neither the list row nor the detail header. Icon + text, same
 * "never colour alone" rule `CHECK_STATE_DISPLAY` already follows. */
export const PULL_REQUEST_STATE_DISPLAY: Record<PullRequestState, CheckDisplay> = {
  open: { icon: GitPullRequestIcon, label: 'Open' },
  draft: { icon: GitPullRequestDraftIcon, label: 'Draft' },
  closed: { icon: GitPullRequestClosedIcon, label: 'Closed' },
  merged: { icon: GitMergeIcon, label: 'Merged' }
}

export function PullRequestRow({ pullRequest, selected, onSelect }: PullRequestRowProps) {
  const check = CHECK_STATE_DISPLAY[pullRequest.checkState]
  const CheckIcon = check.icon
  const state = PULL_REQUEST_STATE_DISPLAY[pullRequest.state]
  const StateIcon = state.icon
  const authorLabel = pullRequest.author.name ?? pullRequest.author.login

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      // Gate-fix (round 3, script): a stable, intentional hook for the live-check driver --
      // replaces brittle class-based row/state scraping (`.divide-y > button`, a text-content
      // read of an inner span sharing classes with its own parent) with real data, never parsed
      // display text or container styling an unrelated refactor could silently break.
      data-pr-row
      data-pr-number={pullRequest.number}
      data-pr-author={pullRequest.author.login}
      data-pr-state={pullRequest.state}
      className="relative flex w-full flex-col gap-1 px-3 py-2 text-left text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {selected && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]"
        />
      )}
      <span className="flex items-center gap-1.5 font-medium">
        <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">#{pullRequest.number}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <StateIcon aria-hidden className="size-3.5" />
          {state.label}
        </span>
        <span aria-hidden="true">{'\u00b7'}</span>
        <span className="flex items-center gap-1">
          <CheckIcon
            aria-hidden
            className={cn(
              'size-3.5',
              pullRequest.checkState === 'pending' && 'animate-spin',
              pullRequest.checkState === 'failed' && 'text-severity-error'
            )}
          />
          {check.label}
        </span>
        <span aria-hidden="true">{'\u00b7'}</span>
        <span className="truncate">{pullRequest.repository}</span>
        <span aria-hidden="true">{'\u00b7'}</span>
        <span className="tabular-nums">{formatRelativeTime(pullRequest.updatedAt)}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">{authorLabel}</span>
    </button>
  )
}
