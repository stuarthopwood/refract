import { forwardRef, useRef } from 'react'
import { CircleCheckIcon, CircleDotIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePinnedPanelsStore } from '@/state'
import type { LinkedIssue } from '../../../../shared/model'

interface LinkedIssueControlsProps {
  repositoryId: string
  /** Ordered: the first entry is the badge; another source (the Session origin issue, #1310) prepends. */
  issues: LinkedIssue[]
}

function IssueIcon({ issue }: { issue: LinkedIssue }) {
  const Icon = issue.state === 'closed' ? CircleCheckIcon : CircleDotIcon
  return <Icon aria-hidden className="size-4" />
}

// Spreads the trigger props a Radix `asChild` parent injects.
const ViewIssueButton = forwardRef<HTMLButtonElement, { label: string } & React.ComponentProps<'button'>>(function ViewIssueButton(
  { label, ...rest },
  ref
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button ref={ref} type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" {...rest} aria-label={label}>
          <CircleDotIcon aria-hidden className="size-4" />
          <span className="@max-[42rem]/chat:hidden">View issue</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})

/** The header's linked-issue badge, "+N" count and View issue button (a menu when there are several). */
export function LinkedIssueControls({ repositoryId, issues }: LinkedIssueControlsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pinnedRef = useRef(false)
  const first = issues[0]
  if (!first) return null
  const extra = issues.length - 1
  const pin = (issue: LinkedIssue) =>
    usePinnedPanelsStore.getState().pin('issue', repositoryId, issue.number, triggerRef.current)
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
            <ViewIssueButton ref={triggerRef} label="View issue" />
          </DropdownMenuTrigger>
          {/* Radix would hand focus back to the trigger and undo the move into the panel. */}
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (pinnedRef.current) event.preventDefault()
              pinnedRef.current = false
            }}
          >
            {issues.map((issue) => (
              <DropdownMenuItem
                key={issue.number}
                onSelect={() => {
                  pinnedRef.current = true
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
        <ViewIssueButton ref={triggerRef} label={`View issue #${first.number}`} onClick={() => pin(first)} />
      )}
    </div>
  )
}
