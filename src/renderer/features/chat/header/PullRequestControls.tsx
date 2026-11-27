import { HeaderRefBadge } from '@/components/HeaderRefBadge'
import { cn } from '@/lib/utils'
import { READOUT_CHECK_DISPLAY } from '@/features/pull-requests/check-display'
import { PULL_REQUEST_STATE_DISPLAY } from '@/features/pull-requests/PullRequestRow'
import { usePinnedPanelsStore } from '@/state'
import { pullRequestBadgeStatus } from './pullRequestBadgeStatus'
import type { PullRequestDisplayState, SessionPullRequest } from '../../../../shared/model'

interface PullRequestControlsProps {
  sessionId: string
  repositoryId: string
  pullRequest: SessionPullRequest
  liveState: PullRequestDisplayState | null
}

/** The header's PR badge (state, number, checks); clicking it pins the pull request. */
export function PullRequestControls({ sessionId, repositoryId, pullRequest, liveState }: PullRequestControlsProps) {
  const checks = pullRequest.checks ? READOUT_CHECK_DISPLAY[pullRequest.checks] : null
  const ChecksIcon = checks?.icon
  const state = liveState ?? pullRequest.state
  const display = PULL_REQUEST_STATE_DISPLAY[state]
  const StateIcon = display.icon

  return (
    <div className="flex shrink-0 items-center gap-1">
      <HeaderRefBadge
        icon={<StateIcon aria-hidden className={cn('size-4', display.colorClass)} />}
        text={`#${pullRequest.number}`}
        status={pullRequestBadgeStatus(state, pullRequest.checks)}
        action="open pull request"
        trailing={
          checks && ChecksIcon ? (
            <ChecksIcon aria-hidden className={cn('size-4', checks.colorClass, 'forced-colors:text-[CanvasText]')} />
          ) : undefined
        }
        onClick={(event) => usePinnedPanelsStore.getState().pin('pull-request', { repositoryId, number: pullRequest.number, sessionId, opener: event.currentTarget })}
      />
    </div>
  )
}
