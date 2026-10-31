import { useRef } from 'react'
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

/** The header's linked-issue badge, "+N" count and View issue button (a menu when there are several). */
export function LinkedIssueControls({ repositoryId, issues }: LinkedIssueControlsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const first = issues[0]
  if (!first) return null
  const extra = issues.length - 1
  const pin = (issue: LinkedIssue) =>
    usePinnedPanelsStore.getState().pin('issue', repositoryId, issue.number, triggerRef.current)
  const badgeText = `Issue #${first.number}, ${first.state}${extra > 0 ? `, and ${extra} more` : ''}`

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Badge variant="outline" title={first.title} aria-label={badgeText}>
        <IssueIcon issue={first} />
        <span aria-hidden>#{first.number}</span>
        {extra > 0 && <span aria-hidden>+{extra}</span>}
      </Badge>
      {extra > 0 ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button ref={triggerRef} type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" aria-label="View issue">
                  <CircleDotIcon aria-hidden className="size-4" />
                  <span className="@max-[42rem]/chat:hidden">View issue</span>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>View issue</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {issues.map((issue) => (
              <DropdownMenuItem key={issue.number} onSelect={() => pin(issue)}>
                <IssueIcon issue={issue} />
                <span className="max-w-64 truncate">#{issue.number} {issue.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              aria-label={`View issue #${first.number}`}
              onClick={() => pin(first)}
            >
              <CircleDotIcon aria-hidden className="size-4" />
              <span className="@max-[42rem]/chat:hidden">View issue</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{`View issue #${first.number}`}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
