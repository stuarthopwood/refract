// One row in the Issues list (issue #504, spec 051). Title and number, then state (icon + word,
// never colour alone), Project, assignee, comments and time, then at most two labels. Every text
// field comes from GitHub and renders as plain text only.
import { CircleCheckIcon, CircleDotIcon, MessageSquareIcon } from 'lucide-react'
import { useId } from 'react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { ColourDot } from '@/components/ColourDot'
import { LabelOverflow } from '@/components/LabelOverflow'
import { splitOverflowLabels } from '@/components/overflowLabels'
import { RelativeTime, formatFullDateTime } from '@/components/relative-time'
import { ROW_KEBAB_INSET_CLASS } from '@/components/RowKebabMenu'
import { cn } from '@/lib/utils'
import type { IssueListItem } from '../../../shared/ipc-issues'
import type { CheckStateDisplay } from '../pull-requests/check-display'

const MAX_ROW_LABELS = 2

/** Icon and word for an issue's state; shared with the command palette so both name it the same way. */
export const ISSUE_STATE_DISPLAY: Record<IssueListItem['state'], CheckStateDisplay> = {
  OPEN: { icon: CircleDotIcon, label: 'Open', colorClass: 'text-pr-open' },
  CLOSED: { icon: CircleCheckIcon, label: 'Closed', colorClass: 'text-pr-merged' }
}

interface IssueRowProps {
  issue: IssueListItem
  selected: boolean
  onSelect(): void
}

export function IssueRow({ issue, selected, onSelect }: IssueRowProps) {
  const updatedId = useId()
  const { icon: StateIcon } = ISSUE_STATE_DISPLAY[issue.state]
  const { shown: shownLabels, hidden: hiddenLabels } = splitOverflowLabels(issue.labels, MAX_ROW_LABELS)

  return (
    <div
      className={cn(
        'relative flex w-full flex-col gap-1 py-2 pl-4 text-left text-sm',
        ROW_KEBAB_INSET_CLASS,
        selected ? 'bg-accent text-accent-foreground' : 'group-hover/row:bg-surface-hover'
      )}
    >
      {selected && <ActiveIndicatorBar />}
      {/* The button's ::after stretches over the whole row so a click anywhere selects; the overflow chip sits above it as a sibling because a button cannot contain another focusable control. */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-describedby={updatedId}
        data-issue-row
        data-issue-number={issue.number}
        data-issue-repo={issue.ownerRepo}
        data-issue-state={issue.state}
        className="flex w-full flex-col gap-1 text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-solid focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-ring"
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">#{issue.number}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <StateIcon aria-hidden className="size-4" />
            {ISSUE_STATE_DISPLAY[issue.state].label}
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
        <span id={updatedId} className="sr-only">
          Updated {formatFullDateTime(issue.updatedAt)}
        </span>
      </button>
      {issue.labels.length > 0 && (
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {shownLabels.map((label) => (
            <span key={label.name} className="flex min-w-0 items-center gap-1">
              <ColourDot color={label.color} />
              <span className="truncate">{label.name}</span>
            </span>
          ))}
          <LabelOverflow labels={hiddenLabels} className="relative -my-1" />
        </span>
      )}
    </div>
  )
}
