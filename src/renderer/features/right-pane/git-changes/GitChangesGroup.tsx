// Spec 018 slice 1 (issue #464), User Story 1: one of the four fixed groups (Conflicts/Staged/
// Changes/Untracked), rendered through `GroupHeaderTrigger` exactly (leading chevron, trailing
// `(N)` count, research.md decision 9) plus its own bulk action (Stage all / Unstage all) --
// Conflicts gets no bulk action at all (a developer resolves a conflict per-file, matching
// `ipc/git_changes.rs`'s own bulk handlers, which already exclude it server-side).
import { useEffect, useRef, useState } from 'react'
import { Loader2Icon, MinusIcon, PlusIcon, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useGitChangesStore } from '@/state'
import { GroupHeaderRow, GroupHeaderTrigger, HEADER_ACTION_BUTTON_CLASS } from '@/features/sessions/GroupHeader'
import { cn } from '@/lib/utils'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'
import { GitChangesFileRow } from './GitChangesFileRow'
import { focusNearestGroupTrigger } from './focus'

const GROUP_LABELS: Record<GitChangesGroupKind, string> = {
  conflicts: 'Conflicts',
  staged: 'Staged',
  changes: 'Changes',
  untracked: 'Untracked'
}

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
  open,
  onOpenChange,
  onOpenDiff
}: {
  kind: GitChangesGroupKind
  entries: GitChangesFileEntry[]
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenDiff: (entry: GitChangesFileEntry, group: GitChangesGroupKind) => void
}) {
  const label = GROUP_LABELS[kind]
  const bulk = BULK_ACTION[kind]
  const bulkAccessibleName = bulk ? `${bulk.label} in ${label}` : null
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    triggerRef.current?.setAttribute('data-git-group-trigger', kind)
  }, [kind])
  // Item 3 (#1101): same local-state, set-before/clear-in-`finally` in-flight pattern as
  // `GitChangesFileRow.tsx`'s own per-row `actionPending` (mirrors the Commit button's
  // `committing`, the state-location convention #1093's own Low item flags for that button).
  const [bulkPending, setBulkPending] = useState(false)

  async function runBulkAction(): Promise<void> {
    if (bulkPending || !bulk) return
    setBulkPending(true)
    // Item 3 (#1101): the existing app-level `role="status"` region (`chatAreaAnnouncer.ts`) covers
    // the screen-reader side of the in-progress state -- no new live region.
    useChatAreaAnnouncer.getState().announce(`${bulkAccessibleName}…`)
    try {
      const result =
        kind === 'staged'
          ? await useGitChangesStore.getState().unstageAll(sessionId)
          // `bulk` (and therefore this button) only ever renders for 'changes'/'untracked'
          // (BULK_ACTION above has no entry for 'conflicts'), so this narrowing is exhaustive in
          // practice.
          : kind === 'changes' || kind === 'untracked'
            ? await useGitChangesStore.getState().stageAll(sessionId, kind)
            : null
      if (result === null) return
      if (result.ok) {
        useChatAreaAnnouncer.getState().announce(`${bulkAccessibleName} done`)
        focusNearestGroupTrigger(sessionId, kind)
      }
    } finally {
      setBulkPending(false)
    }
  }

  return (
    <div className="flex flex-col">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <GroupHeaderRow>
          <GroupHeaderTrigger label={label} count={entries.length} triggerRef={triggerRef} />
          {bulk && (
            <Tooltip>
              {/* Low item (#1111): `aria-describedby={undefined}` stops Radix pointing the trigger at this tooltip's own content -- `aria-label` below already is the full accessible name, so without this a screen reader reads it twice. */}
              <TooltipTrigger asChild aria-describedby={undefined}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={bulkAccessibleName ?? undefined}
                  aria-busy={bulkPending}
                  aria-disabled={bulkPending || undefined}
                  // Low item (#1111): `aria-disabled:opacity-50` -- every other busy control in
                  // this panel dims while pending (`GitChangesFileRow.tsx`'s kebab trigger, the
                  // Commit button); this one didn't.
                  className={cn('shrink-0 aria-disabled:opacity-50', HEADER_ACTION_BUTTON_CLASS)}
                  onClick={() => void runBulkAction()}
                >
                  {bulkPending ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : <bulk.icon aria-hidden className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{bulkAccessibleName}</TooltipContent>
            </Tooltip>
          )}
        </GroupHeaderRow>
        <CollapsibleContent>
          <ul data-git-group-list={kind} aria-label={`${label} files`} className="flex flex-col gap-0 py-1">
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
