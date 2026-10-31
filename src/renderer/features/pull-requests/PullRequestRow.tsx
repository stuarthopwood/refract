// One row in the pull request list (specs/003-pull-request-management FR-005, T013): title,
// number, check status (icon + text, never colour alone -- FR-030), repository, time since last
// updated, and author.
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon
} from 'lucide-react'
import { useId, type ComponentType } from 'react'
import type { PullRequestState } from '../../../shared/github'
import type { PullRequestAcrossItem } from '../../../shared/ipc-pull-requests'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { RelativeTime, formatFullDateTime } from '@/components/relative-time'
import { cn } from '@/lib/utils'

interface PullRequestRowProps {
  pullRequest: PullRequestAcrossItem
  selected: boolean
  onSelect(): void
}

export interface CheckDisplay {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  label: string
}

export interface CheckStateDisplay extends CheckDisplay {
  /** Issue #1121 (2026-10-21 decision): every non-`none` check state now carries its own
   * severity colour, on both the icon and the label word -- supersedes #568 decision 5 ("check
   * status stays a plain icon+word, turning red only on failure") for PR checks only; tool-call
   * rows elsewhere keep #570's own failure-only colour rule, unaffected. `none` keeps
   * `text-muted-foreground`, the same colour both surfaces already showed. */
  colorClass: string
}

// Re-exported for PullRequestDetail, still importing it from here (follow-up: lane #1501 owns that file).
export { CHECK_STATE_DISPLAY } from './check-display'

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
  const state = PULL_REQUEST_STATE_DISPLAY[pullRequest.state]
  const StateIcon = state.icon
  const authorLabel = pullRequest.author.name ?? pullRequest.author.login
  const updatedId = useId()

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      aria-describedby={updatedId}
      // Gate-fix (round 3, script): a stable, intentional hook for the live-check driver --
      // replaces brittle class-based row/state scraping (`.divide-y > button`, a text-content
      // read of an inner span sharing classes with its own parent) with real data, never parsed
      // display text or container styling an unrelated refactor could silently break.
      data-pr-row
      data-pr-number={pullRequest.number}
      data-pr-author={pullRequest.author.login}
      data-pr-state={pullRequest.state}
      // Issue #1122: the PR list row gains the same accent fill every other persistent selected
      // row already has (it previously had the bar below but no fill at all).
      className={cn(
        'relative flex w-full flex-col gap-1 px-4 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-surface-hover'
      )}
    >
      {/* Issue #1122: the shared `ActiveIndicatorBar` (square, flush full-height, 2px) replaces
          this row's own hand-copied rounded-pill/inset span. */}
      {selected && <ActiveIndicatorBar />}
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">#{pullRequest.number}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <StateIcon aria-hidden className="size-4" />
          {state.label}
        </span>
        <span aria-hidden="true">{'\u00b7'}</span>
        <span className="truncate" data-pr-repository={pullRequest.repository}>{pullRequest.repositoryName}</span>
        <span aria-hidden="true">{'\u00b7'}</span>
        <span className="tabular-nums"><RelativeTime value={pullRequest.updatedAt} focusable={false} /></span>
      </span>
      <span className="truncate text-xs text-muted-foreground">{authorLabel}</span>
      <span id={updatedId} className="sr-only">Updated {formatFullDateTime(pullRequest.updatedAt)}</span>
    </button>
  )
}
