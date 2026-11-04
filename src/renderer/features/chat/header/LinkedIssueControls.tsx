import { useRef } from 'react'
import { CircleCheckIcon, CircleDotIcon, CircleHelpIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { HeaderActionButton } from '@/components/HeaderActionButton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { usePinnedPanelsStore } from '@/state'
import { usePinFromMenu } from './usePinFromMenu'
import type { LinkedIssue } from '../../../../shared/model'

interface LinkedIssueControlsProps {
  sessionId: string
  repositoryId: string
  /** Ordered: the first entry is the badge; `HeaderPrControls` puts the Session's origin issue first. */
  issues: LinkedIssue[]
}

function IssueIcon({ issue }: { issue: LinkedIssue }) {
  const Icon = issue.state === 'closed' ? CircleCheckIcon : issue.state === 'unknown' ? CircleHelpIcon : CircleDotIcon
  return <Icon aria-hidden className="size-4" />
}

/** The header's linked-issue badge, "+N" count and View issue button (a menu when there are several). */
export function LinkedIssueControls({ sessionId, repositoryId, issues }: LinkedIssueControlsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { markPinned, onCloseAutoFocus } = usePinFromMenu()
  const first = issues[0]
  if (!first) return null
  const extra = issues.length - 1
  const pin = (issue: LinkedIssue) =>
    usePinnedPanelsStore.getState().pin('issue', { repositoryId, number: issue.number, sessionId, opener: triggerRef.current })
  const badgeText = `Issue #${first.number}, ${first.state}${extra > 0 ? `, and ${extra} more` : ''}`

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Badge variant="outline" role="img" title={first.title} aria-label={badgeText}>
        <IssueIcon issue={first} />
        <span aria-hidden>#{first.number}</span>
        {extra > 0 && <span aria-hidden>+{extra}</span>}
      </Badge>
      {extra > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <HeaderActionButton ref={triggerRef} icon={CircleDotIcon} text="View issue" label="View issue" />
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
                <IssueIcon issue={issue} />
                <span className="sr-only">{issue.state}</span>
                <span className="max-w-64 truncate">#{issue.number} {issue.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <HeaderActionButton ref={triggerRef} icon={CircleDotIcon} text="View issue" label={`View issue #${first.number}`} onClick={() => pin(first)} />
      )}
    </div>
  )
}
