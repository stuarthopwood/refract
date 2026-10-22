// Spec 019 (issue #724): the live checked-out branch of this pane's Session worktree, shown after
// the Reasoning picker in the composer's bottom row. The value is `SessionReadout.branch`, read
// live by the Rust readout (and refreshed by its HEAD watch, `readout_head_watch.rs`); nothing is
// shown while it is `null` (no readable worktree). Activating it opens the Git changes panel for
// this Session, the same explicit-activation path the Changes readout uses.
import type { MouseEvent } from 'react'
import { GitBranchIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openHostedPanel } from '@/features/right-pane/hosted-panel-actions'
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSessionsStore } from '@/state'
import { PICKER_TRIGGER_CLASS } from './pickerShared'

export function ComposerBranchLabel({ sessionId }: { sessionId: string }) {
  const branch = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.branch ?? null)
  const sessionBranch = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.branch)
  const baseBranch = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.baseBranch)
  if (!branch || !branch.name) return null
  const label = branch.detached ? `Detached at ${branch.name}` : branch.name
  const differs = !branch.detached && sessionBranch !== undefined && sessionBranch !== branch.name
  const onClick = (event: MouseEvent<HTMLButtonElement>) =>
    openHostedPanel('git-changes', sessionId, { opener: event.currentTarget })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-composer-branch
          aria-label={`Branch: ${label}. Open Git changes panel`}
          aria-describedby={undefined}
          // Spec 019 FR-006: `flex: 1 1 0` with `max-width: max-content` never forces the row to
          // wrap on its own length and yields space before any sibling; `min-w-16` keeps a few
          // characters visible before the row wraps it onto its own line instead.
          className={cn(PICKER_TRIGGER_CLASS, 'min-w-16 max-w-max flex-[1_1_0%] shrink')}
          onClick={onClick}
        >
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          <span className="break-all">{label}</span>
          {baseBranch && <span>From {baseBranch}</span>}
          {differs && <span>Session branch: {sessionBranch}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
