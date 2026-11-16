// One row in the pull request list (specs/003-pull-request-management FR-005, T013): title,
// number, check status (icon + text, never colour alone -- FR-030), repository, time since last
// updated, and author.
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon
} from 'lucide-react'
import { useId } from 'react'
import type { PullRequestState } from '../../../shared/github'
import type { PullRequestAcrossItem } from '../../../shared/ipc-pull-requests'
import type { CheckDisplay } from './check-display'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { StackBadge } from '@/components/StackBadge'
import type { StackPosition } from '../../../shared/stack-chain'
import { RelativeTime, formatFullDateTime } from '@/components/relative-time'
import { ROW_KEBAB_INSET_CLASS } from '@/components/RowKebabMenu'
import { cn } from '@/lib/utils'

interface PullRequestRowProps {
  pullRequest: PullRequestAcrossItem
  selected: boolean
  /** Where this pull request sits in a stack; `undefined` when it is not stacked or the feature is off. */
  stack?: StackPosition
  onSelect(): void
}

export { CHECK_STATE_DISPLAY, type CheckDisplay, type CheckStateDisplay } from './check-display'
import type { CheckStateDisplay } from './check-display'

/** High remediation (accessibility-auditor, FR-007/FR-030): open/draft/closed/merged was never
 * visibly conveyed anywhere -- neither the list row nor the detail header. Icon + text, same
 * "never colour alone" rule `CHECK_STATE_DISPLAY` already follows. */
export const PULL_REQUEST_STATE_DISPLAY: Record<PullRequestState, CheckStateDisplay> = {
  open: { icon: GitPullRequestIcon, label: 'Open', colorClass: 'text-pr-open' },
  draft: { icon: GitPullRequestDraftIcon, label: 'Draft', colorClass: 'text-pr-draft' },
  closed: { icon: GitPullRequestClosedIcon, label: 'Closed', colorClass: 'text-pr-closed' },
  merged: { icon: GitMergeIcon, label: 'Merged', colorClass: 'text-pr-merged' }
}

export function PullRequestRow({ pullRequest, selected, stack, onSelect }: PullRequestRowProps) {
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
        'relative flex w-full flex-col gap-1 py-2 pl-4 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
        ROW_KEBAB_INSET_CLASS,
        selected ? 'bg-accent text-accent-foreground' : 'group-hover/row:bg-surface-hover'
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
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{authorLabel}</span>
        {stack && <StackBadge position={stack.position} total={stack.total} className="shrink-0" />}
      </span>
      <span id={updatedId} className="sr-only">Updated {formatFullDateTime(pullRequest.updatedAt)}</span>
    </button>
  )
}
