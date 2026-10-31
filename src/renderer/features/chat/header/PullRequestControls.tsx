import { GitPullRequestIcon } from 'lucide-react'
import { HeaderActionButton } from '@/components/HeaderActionButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { READOUT_CHECK_DISPLAY } from '@/features/pull-requests/check-display'
import { PULL_REQUEST_STATE_DISPLAY } from '@/features/pull-requests/PullRequestRow'
import { StatePill } from '@/features/pull-requests/StatePill'
import { usePinnedPanelsStore } from '@/state'
import type { PullRequestDisplayState, SessionPullRequest } from '../../../../shared/model'

interface PullRequestControlsProps {
  sessionId: string
  repositoryId: string
  pullRequest: SessionPullRequest
  liveState: PullRequestDisplayState | null
}

/** The header's PR badge (state, number, checks) and the View PR button. */
export function PullRequestControls({ sessionId, repositoryId, pullRequest, liveState }: PullRequestControlsProps) {
  const checks = pullRequest.checks ? READOUT_CHECK_DISPLAY[pullRequest.checks] : null
  const ChecksIcon = checks?.icon
  const label = `View pull request #${pullRequest.number}`
  const state = liveState ?? pullRequest.state

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex rounded-md">
            <StatePill state={state} variant="subtle" labelClassName="@max-chat-narrow/chat:sr-only" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{PULL_REQUEST_STATE_DISPLAY[state].label}</TooltipContent>
      </Tooltip>
      <span className="text-xs text-muted-foreground">#{pullRequest.number}</span>
      {checks && ChecksIcon && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="img"
              aria-label={checks.label}
              className={cn('flex rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring forced-colors:text-[CanvasText] forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-solid', checks.colorClass)}
            >
              <ChecksIcon aria-hidden className={cn('size-4', pullRequest.checks === 'pending' && 'animate-spin motion-reduce:animate-none')} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{checks.label}</TooltipContent>
        </Tooltip>
      )}
      <HeaderActionButton
        icon={GitPullRequestIcon}
        text="View PR"
        label={label}
        onClick={(event) => usePinnedPanelsStore.getState().pin('pull-request', { repositoryId, number: pullRequest.number, sessionId, opener: event.currentTarget })}
      />
    </div>
  )
}