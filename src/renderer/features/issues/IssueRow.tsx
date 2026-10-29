// One row in the Issues list (issue #504, spec 051). Title and number, then state (icon + word,
// never colour alone), Project, assignee, comments and time, then at most two labels. Every text
// field comes from GitHub and renders as plain text only.
import { CircleCheckIcon, CircleDotIcon, MessageSquareIcon } from 'lucide-react'
import { useId } from 'react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { ColourDot } from '@/components/ColourDot'
import { RelativeTime, formatFullDateTime } from '@/components/relative-time'
import { cn } from '@/lib/utils'
import type { IssueListItem } from '../../../shared/ipc-issues'

const MAX_ROW_LABELS = 2

interface IssueRowProps {
  issue: IssueListItem
  selected: boolean
  onSelect(): void
}

export function IssueRow({ issue, selected, onSelect }: IssueRowProps) {
  const updatedId = useId()
  const open = issue.state === 'OPEN'
  const StateIcon = open ? CircleDotIcon : CircleCheckIcon
  const shownLabels = issue.labels.slice(0, MAX_ROW_LABELS)
  const hiddenLabels = issue.labels.length - shownLabels.length

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      aria-describedby={updatedId}
      data-issue-row
      data-issue-number={issue.number}
      data-issue-repo={issue.ownerRepo}
      data-issue-state={issue.state}
      className={cn(
        'relative flex w-full flex-col gap-1 px-4 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-surface-hover'
      )}
    >
      {selected && <ActiveIndicatorBar />}
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">#{issue.number}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <StateIcon aria-hidden className="size-4" />
          {open ? 'Open' : 'Closed'}
        </span>
        <span aria-hidden="true">{'\u00b7'}</span>
        <span className="truncate">{issue.repositoryName}</span>
        {issue.assignees.length > 0 && (
          <>
            <span aria-hidden="true">{'\u00b7'}</span>
            <span className="truncate">{issue.assignees[0]}</span>
          </>
        )}
        {issue.commentCount > 0 && (
          <>
            <span aria-hidden="true">{'\u00b7'}</span>
            <span className="flex items-center gap-1">
              <MessageSquareIcon aria-hidden className="size-3.5" />
              <span className="tabular-nums">{issue.commentCount}</span>
              <span className="sr-only">comments</span>
            </span>
          </>
        )}
        <span aria-hidden="true">{'\u00b7'}</span>
        <span className="tabular-nums">
          <RelativeTime value={issue.updatedAt} focusable={false} />
        </span>
      </span>
      {shownLabels.length > 0 && (
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {shownLabels.map((label) => (
            <span key={label.name} className="flex min-w-0 items-center gap-1">
              <ColourDot color={label.color} />
              <span className="truncate">{label.name}</span>
            </span>
          ))}
          {hiddenLabels > 0 && <span>+{hiddenLabels}</span>}
        </span>
      )}
      <span id={updatedId} className="sr-only">
        Updated {formatFullDateTime(issue.updatedAt)}
      </span>
    </button>
  )
}
