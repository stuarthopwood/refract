// Solid-fill state pill for a pull request's open/draft/closed/merged state (#568 decision 5).
// Reuses `PULL_REQUEST_STATE_DISPLAY`'s existing icon+label map rather than redefining it --
// this component only adds the per-state fill colour.
import { PULL_REQUEST_STATE_DISPLAY } from './PullRequestRow'
import type { PullRequestState } from '../../../shared/github'
import { cn } from '@/lib/utils'

const STATE_PILL_CLASS: Record<PullRequestState, string> = {
  open: 'bg-pr-open text-pr-open-foreground',
  draft: 'bg-pr-draft text-pr-draft-foreground',
  closed: 'bg-pr-closed text-pr-closed-foreground',
  merged: 'bg-pr-merged text-pr-merged-foreground'
}

export interface StatePillProps {
  state: PullRequestState
  className?: string
}

export function StatePill({ state, className }: StatePillProps) {
  const display = PULL_REQUEST_STATE_DISPLAY[state]
  const Icon = display.icon

  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs forced-color-adjust-none forced-colors:border forced-colors:border-[ButtonText]',
        STATE_PILL_CLASS[state],
        className
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {display.label}
    </span>
  )
}
