// Spec 018 slice 1 (issue #464), User Story 1: one of the four fixed groups (Conflicts/Staged/
// Changes/Untracked), rendered through `GroupHeaderTrigger` exactly (leading chevron, trailing
// `(N)` count, research.md decision 9) plus its own bulk action (Stage all / Unstage all,
// FR-004) -- Conflicts gets no bulk action at all (a developer resolves a conflict per-file,
// matching `ipc/git_changes.rs`'s own bulk handlers, which already exclude it server-side).
import { useState } from 'react'
import { MinusIcon, PlusIcon, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useGitChangesStore } from '@/state'
import { GroupHeaderTrigger } from '@/features/sessions/GroupHeader'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'
import { GitChangesFileRow } from './GitChangesFileRow'

const GROUP_LABELS: Record<GitChangesGroupKind, string> = {
  conflicts: 'Conflicts',
  staged: 'Staged',
  changes: 'Changes',
  untracked: 'Untracked'
}

// FR-004: "Stage all" on Changes/Untracked, "Unstage all" on Staged, nothing on Conflicts.
const BULK_ACTION: Record<GitChangesGroupKind, { label: string; icon: LucideIcon } | null> = {
  conflicts: null,
  staged: { label: 'Unstage all', icon: MinusIcon },
  changes: { label: 'Stage all', icon: PlusIcon },
  untracked: { label: 'Stage all', icon: PlusIcon }
}

export function GitChangesGroup({
  kind,
  entries,
  sessionId,
  onOpenDiff
}: {
  kind: GitChangesGroupKind
  entries: GitChangesFileEntry[]
  sessionId: string
  onOpenDiff: (entry: GitChangesFileEntry, group: GitChangesGroupKind) => void
}) {
  const [open, setOpen] = useState(true)
  const label = GROUP_LABELS[kind]
  const bulk = BULK_ACTION[kind]
  // FR-004's own wording: "an accessible name that includes the group's own name (for example
  // 'Stage all in Changes')".
  const bulkAccessibleName = bulk ? `${bulk.label} in ${label}` : null

  function runBulkAction(): void {
    if (kind === 'staged') void useGitChangesStore.getState().unstageAll(sessionId)
    // `bulk` (and therefore this button) only ever renders for 'changes'/'untracked' (BULK_ACTION
    // above has no entry for 'conflicts'), so this narrowing is exhaustive in practice.
    else if (kind === 'changes' || kind === 'untracked') void useGitChangesStore.getState().stageAll(sessionId, kind)
  }

  return (
    <div className="group flex flex-col">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-1 px-1">
          <GroupHeaderTrigger label={label} count={entries.length} />
          {bulk && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={bulkAccessibleName ?? undefined}
                  className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  onClick={runBulkAction}
                >
                  <bulk.icon aria-hidden className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{bulkAccessibleName}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <CollapsibleContent>
          <ul aria-label={`${label} files`} className="flex flex-col gap-0 py-0.5">
            {entries.map((entry) => (
              <li key={entry.path}>
                <GitChangesFileRow
                  entry={entry}
                  group={kind}
                  sessionId={sessionId}
                  onOpenDiff={() => onOpenDiff(entry, kind)}
                />
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
