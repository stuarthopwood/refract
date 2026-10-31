import { GitPullRequestIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CHECK_STATE_DISPLAY } from '@/features/pull-requests/PullRequestRow'
import { StatePill } from '@/features/pull-requests/StatePill'
import { usePinnedPanelsStore } from '@/state'
import type { PullRequestChecks, PullRequestDisplayState, SessionPullRequest } from '../../../../shared/model'

const CHECKS_TO_DISPLAY = { pass: 'passed', fail: 'failed', pending: 'pending' } as const satisfies Record<PullRequestChecks, keyof typeof CHECK_STATE_DISPLAY>

interface PullRequestControlsProps {
  repositoryId: string
  pullRequest: SessionPullRequest
  liveState: PullRequestDisplayState | null
}

/** The header's PR badge (state, number, checks) and the View PR button. */
export function PullRequestControls({ repositoryId, pullRequest, liveState }: PullRequestControlsProps) {
  const checks = pullRequest.checks ? CHECK_STATE_DISPLAY[CHECKS_TO_DISPLAY[pullRequest.checks]] : null
  const ChecksIcon = checks?.icon
  const label = `View pull request #${pullRequest.number}`

  return (
    <div className="flex shrink-0 items-center gap-1">
      <StatePill state={liveState ?? pullRequest.state} labelClassName="@max-[42rem]/chat:sr-only" />
      <span className="text-xs text-muted-foreground">#{pullRequest.number}</span>
      {checks && ChecksIcon && (
        <span role="img" aria-label={checks.label} title={checks.label} className={cn('flex', checks.colorClass)}>
          <ChecksIcon aria-hidden className={cn('size-4', pullRequest.checks === 'pending' && 'animate-spin motion-reduce:animate-none')} />
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            aria-label={label}
            onClick={(event) => usePinnedPanelsStore.getState().pin('pull-request', repositoryId, pullRequest.number, event.currentTarget)}
          >
            <GitPullRequestIcon aria-hidden className="size-4" />
            <span className="@max-[42rem]/chat:hidden">View PR</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  )
}
