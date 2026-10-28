// Spec 018 slice 1 (issue #464), User Story 1: one of the four fixed groups (Conflicts/Staged/
// Changes/Untracked), rendered through `GroupHeaderTrigger` exactly (leading chevron, trailing
// `(N)` count, research.md decision 9) plus its own bulk action (Stage all / Unstage all,
// FR-004) -- Conflicts gets no bulk action at all (a developer resolves a conflict per-file,
// matching `ipc/git_changes.rs`'s own bulk handlers, which already exclude it server-side).
//
// Gate round 1 (LOW, cheap to do): `open` is now owned by `GitChangesPanel.tsx`, keyed per
// group kind, instead of this component's own local `useState` -- a local `useState` reset to
// its default (`true`, open) every time this component remounted, which happened on every trip
// out to a file's diff and back (the Panel swaps its rendered content between the four-group
// list and the diff pane, unmounting this whole list in between) -- a developer's own collapse
// choices were silently discarded by opening a single diff.
import { useEffect, useRef, useState } from 'react'
import { Loader2Icon, MinusIcon, PlusIcon, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useGitChangesStore } from '@/state'
import { GroupHeaderTrigger } from '@/features/sessions/GroupHeader'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'
import { GitChangesFileRow } from './GitChangesFileRow'
import { focusNearestGroupTrigger } from './focus'

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
  // FR-004's own wording: "an accessible name that includes the group's own name (for example
  // 'Stage all in Changes')".
  const bulkAccessibleName = bulk ? `${bulk.label} in ${label}` : null
  // Item 7 (gate round 1): `GitChangesPanel.tsx`'s own post-bulk-action focus restore queries
  // for "the next group's trigger" by kind -- `GroupHeaderTrigger` is shared with the Sessions
  // list and takes no `data-*` prop of its own, so the attribute is set imperatively on the ref
  // it already exposes (`triggerRef`), rather than widening that shared component for one
  // caller's own query hook.
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
    // Item 3 (#1101): the existing app-level `role="status"` region (`chatAreaAnnouncer.ts`)
    // covers the screen-reader side of the in-progress state -- no new live region.
    useChatAreaAnnouncer.getState().announce(`${bulkAccessibleName}…`)
    try {
      // Gate round 3 fix (#1076 HIGH 1): reads the `Result<void>` each action returns DIRECTLY --
      // never re-reads `actionError` from the store after the fact, which raced an unrelated
      // in-flight refresh (Gate1076Test3).
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
      // Item 7 (gate round 1): "Stage all"/"Unstage all" focuses the NEXT group's own trigger.
      // Gate round 2 item 10: only when the action actually succeeded -- a failure leaves
      // `actionError` set (GitCommitBox's own role="alert" announces it), and yanking focus away
      // from the bulk-action button the developer just clicked would both lose their place and
      // read as though nothing happened. Focus naturally stays on that same button by simply
      // skipping the restore call, no extra bookkeeping needed.
      if (result.ok) {
        useChatAreaAnnouncer.getState().announce(`${bulkAccessibleName} done`)
        focusNearestGroupTrigger(sessionId, kind)
      }
    } finally {
      setBulkPending(false)
    }
  }

  return (
    <div className="group flex flex-col">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex items-center gap-1 px-1">
          <GroupHeaderTrigger label={label} count={entries.length} triggerRef={triggerRef} />
          {bulk && (
            <Tooltip>
              {/* Low item (#1111): `aria-describedby={undefined}` stops Radix pointing the
                  trigger at this tooltip's own content -- `aria-label` below already is the
                  full accessible name, so without this a screen reader reads it twice (repo
                  convention, e.g. `RefreshButton.tsx`). */}
              <TooltipTrigger asChild aria-describedby={undefined}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={bulkAccessibleName ?? undefined}
                  aria-busy={bulkPending}
                  aria-disabled={bulkPending || undefined}
                  // Low item (#1111): `aria-disabled:opacity-50` -- every other busy control in
                  // this panel dims while pending (`GitChangesFileRow.tsx`'s kebab trigger, the
                  // Commit button); this one didn't. Gate round 2 LOW: the conditional
                  // `bulkPending && 'opacity-100'` class this file used to also carry here was
                  // dead weight -- `aria-disabled:opacity-50`'s own attribute-selector
                  // specificity always wins over a plain `.opacity-100` class regardless of
                  // source order, so it never had any visual effect.
                  className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  onClick={() => void runBulkAction()}
                >
                  {bulkPending ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : <bulk.icon aria-hidden className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{bulkAccessibleName}</TooltipContent>
            </Tooltip>
          )}
        </div>
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
