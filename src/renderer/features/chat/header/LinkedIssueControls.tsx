import { useRef } from 'react'
import { HeaderRefBadge } from '@/components/HeaderRefBadge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { usePinnedPanelsStore } from '@/state'
import { IssueIcon } from './IssueIcon'
import { usePinFromMenu } from './usePinFromMenu'
import type { LinkedIssue } from '../../../../shared/model'

interface LinkedIssueControlsProps {
  sessionId: string
  repositoryId: string
  /** Ordered: the first entry is the badge; `HeaderPrControls` puts the Session's origin issue first. */
  issues: LinkedIssue[]
}

/** The header's linked-issue badge: it opens the issue, or a menu of them when there are several. */
export function LinkedIssueControls({ sessionId, repositoryId, issues }: LinkedIssueControlsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { markPinned, onCloseAutoFocus } = usePinFromMenu()
  const first = issues[0]
  if (!first) return null
  const extra = issues.length - 1
  const pin = (issue: LinkedIssue) =>
    usePinnedPanelsStore.getState().pin('issue', { repositoryId, number: issue.number, sessionId, opener: triggerRef.current })
  const badgeProps = {
    ref: triggerRef,
    icon: <IssueIcon state={first.state} />,
    text: `#${first.number}`,
    status: first.state,
    extra,
    itemTitle: first.title || undefined
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {extra > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <HeaderRefBadge {...badgeProps} action="show linked issues" />
          </DropdownMenuTrigger>
          {/* Radix would hand focus back to the trigger and undo the move into the panel. */}
          <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
            {issues.map((issue) => (
              <DropdownMenuItem
                key={issue.number}
                onSelect={() => {
                  markPinned()
                  pin(issue)
                }}
              >
                <IssueIcon state={issue.state} />
                <span className="sr-only">{issue.state}</span>
                <span className="max-w-64 truncate">#{issue.number} {issue.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <HeaderRefBadge {...badgeProps} action="open issue" onClick={() => pin(first)} />
      )}
    </div>
  )
}
