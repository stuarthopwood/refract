// One row in the pull request list (specs/003-pull-request-management FR-005, T013): title,
// number, check status (icon + text, never colour alone -- FR-030), repository, time since last
// updated, and author.
import { CheckCircle2Icon, CircleDashedIcon, LoaderCircleIcon, XCircleIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import type { PullRequestSummary } from '../../../shared/github'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { cn } from '@/lib/utils'

interface PullRequestRowProps {
  pullRequest: PullRequestSummary
  selected: boolean
  onSelect(): void
}

export interface CheckDisplay {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  label: string
}

export const CHECK_STATE_DISPLAY: Record<PullRequestSummary['checkState'], CheckDisplay> = {
  passed: { icon: CheckCircle2Icon, label: 'Checks passed' },
  failed: { icon: XCircleIcon, label: 'Checks failed' },
  pending: { icon: LoaderCircleIcon, label: 'Checks running' },
  none: { icon: CircleDashedIcon, label: 'No checks' }
}

export function PullRequestRow({ pullRequest, selected, onSelect }: PullRequestRowProps) {
  const check = CHECK_STATE_DISPLAY[pullRequest.checkState]
  const CheckIcon = check.icon
  const authorLabel = pullRequest.author.name ?? pullRequest.author.login

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md border border-transparent px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
        selected && 'border-border bg-accent'
      )}
    >
      <span className="flex items-center gap-1.5 font-medium">
        <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">#{pullRequest.number}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <CheckIcon aria-hidden className={cn('size-3.5', pullRequest.checkState === 'pending' && 'animate-spin')} />
          {check.label}
        </span>
        <span className="truncate">{pullRequest.repository}</span>
        <span>{formatRelativeTime(pullRequest.updatedAt)}</span>
        <span className="truncate">{authorLabel}</span>
      </span>
    </button>
  )
}
