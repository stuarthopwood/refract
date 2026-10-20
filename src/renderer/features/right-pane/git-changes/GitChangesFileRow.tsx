// Spec 018 slice 1 (issue #464), User Story 1: one file row inside a `GitChangesGroup` --
// status icon+text (reusing `FileExplorerPanel.tsx`'s own `STATUS_MARKS` map unchanged,
// research.md decision 2), name + containing folder (FR-005), a `DiffStatCounts` badge, and the
// per-file actions (Stage/Unstage, Open diff, Open in VS Code, FR-006) behind a kebab menu --
// the same established per-row-actions idiom `FileExplorerPanel.tsx`'s own `TreeNodeRow` already
// uses, rather than a second one-off pattern. Clicking the row's own name/folder area is
// "selecting a row" (FR-008 acceptance scenario 5): it opens the diff exactly like the explicit
// "Open diff" menu item.
//
// Gate round 1 fixes (2026-10-20):
// - Item 6: both focusable controls had `outline-none` (always none) paired only with
//   `focus-visible:outline-2` (width only, never restores `outline-style`) -- the outline never
//   actually painted on keyboard focus. `focus-visible:outline-solid` added alongside, the same
//   fix `SubagentPanel.tsx`'s own gate-round comment already documents (`:focus-visible` wins on
//   specificity, not source order).
// - Item 11: a Conflicts-group row's own menu item is "Mark as resolved" (not "Stage"), gated by
//   a confirmation naming the file and warning that conflict markers may still be present --
//   `DeleteDialog.tsx`/`SignOutDialog.tsx`'s own "AlertDialog driven by local state, sibling of
//   the DropdownMenu, never nested inside its content" pattern (menu items unmount when the menu
//   closes, which would unmount a dialog launched from inside it).
// - Item 16: every menu item and the open-diff button now names the file in its own accessible
//   text ("Stage README.md", "Open diff for README.md", ...), not just the row's ambient text.
// - `data-git-row-path` on the row's own open-diff button: the focus-restore target
//   `GitChangesPanel.tsx` queries for after a stage/unstage changes this row's group membership.
import { useEffect, useRef, useState } from 'react'
import { CheckIcon, Code2Icon, EllipsisVerticalIcon, EyeIcon, MinusIcon, PlusIcon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useGitChangesStore } from '@/state'
import { DiffStatCounts } from '@/features/sessions/sessionDisplay'
import { STATUS_MARKS } from '../file-explorer/FileExplorerPanel'
import { focusGitRow, focusNearestGroupTrigger } from './focus'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'

export function GitChangesFileRow({
  entry,
  group,
  sessionId,
  onOpenDiff
}: {
  entry: GitChangesFileEntry
  group: GitChangesGroupKind
  sessionId: string
  onOpenDiff: () => void
}) {
  const mark = STATUS_MARKS[entry.mark]
  const isConflict = group === 'conflicts'
  const canStage = group !== 'staged'
  const fileName = entry.path.slice(entry.folder ? entry.folder.length + 1 : 0)

  // Mirrors `FileExplorerPanel.tsx`'s own `TreeNodeRow` transient "VS Code not found" state
  // (FR-017, same shared action #463 already exposes) -- a normal result, not an IPC error, so
  // it shows inline rather than as a toast, and auto-clears rather than lingering forever.
  const [vscodeNotFound, setVscodeNotFound] = useState(false)
  useEffect(() => {
    if (!vscodeNotFound) return
    const timer = setTimeout(() => setVscodeNotFound(false), 5000)
    return () => clearTimeout(timer)
  }, [vscodeNotFound])

  async function runOpenInVSCode(): Promise<void> {
    const result = await window.refract.fileExplorer.openInVSCode(sessionId, entry.path)
    setVscodeNotFound(result.ok ? !result.value.opened : true)
  }

  const [confirmResolveOpen, setConfirmResolveOpen] = useState(false)
  const kebabTriggerRef = useRef<HTMLButtonElement>(null)

  // Item 7 (gate round 1): after a single-file stage/unstage (or a conflict's own "mark as
  // resolved", which is a stage under the hood), focus the SAME row again wherever it ended up
  // (it may have moved to a different group) -- falling back to the nearest surviving group
  // trigger only in the rare case the row cannot be found anywhere afterward.
  async function handleStage(): Promise<void> {
    await useGitChangesStore.getState().stage(sessionId, [entry.path])
    if (!focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
  }

  async function handleUnstage(): Promise<void> {
    await useGitChangesStore.getState().unstage(sessionId, [entry.path])
    if (!focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
  }

  async function handleConfirmResolve(): Promise<void> {
    setConfirmResolveOpen(false)
    await handleStage()
  }

  return (
    <div className="group/row flex w-full items-center gap-1.5 rounded px-1 py-1 text-sm hover:bg-accent/50">
      <button
        type="button"
        data-git-row-path={entry.path}
        onClick={onOpenDiff}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <mark.Icon aria-hidden className={`size-3.5 shrink-0 ${mark.className}`} />
        <span className="sr-only">{`${mark.label} — Open diff for ${entry.path}`}</span>
        <span aria-hidden className="min-w-0 flex-1 truncate" title={entry.path}>
          {fileName}
          {entry.folder && <span className="ml-1.5 text-xs text-muted-foreground">{entry.folder}</span>}
        </span>
      </button>
      <DiffStatCounts added={entry.additions} removed={entry.deletions} compact accessibleLabel />
      {entry.partial && <span className="shrink-0 text-xs text-muted-foreground">(partial)</span>}
      {vscodeNotFound && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          VS Code not found
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={kebabTriggerRef}
            type="button"
            aria-label={`More actions for ${entry.path}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100"
          >
            <EllipsisVerticalIcon aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isConflict ? (
            <DropdownMenuItem onSelect={() => setConfirmResolveOpen(true)}>
              <CheckIcon aria-hidden className="size-3.5" />
              {`Mark ${fileName} as resolved`}
            </DropdownMenuItem>
          ) : canStage ? (
            <DropdownMenuItem onSelect={() => void handleStage()}>
              <PlusIcon aria-hidden className="size-3.5" />
              {`Stage ${fileName}`}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void handleUnstage()}>
              <MinusIcon aria-hidden className="size-3.5" />
              {`Unstage ${fileName}`}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onOpenDiff}>
            <EyeIcon aria-hidden className="size-3.5" />
            {`Open diff for ${fileName}`}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void runOpenInVSCode()}>
            <Code2Icon aria-hidden className="size-3.5" />
            {`Open ${fileName} in VS Code`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isConflict && (
        <AlertDialog open={confirmResolveOpen} onOpenChange={setConfirmResolveOpen}>
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              kebabTriggerRef.current?.focus()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Mark {fileName} as resolved?</AlertDialogTitle>
              <AlertDialogDescription>
                This stages {entry.path} exactly as it is in the worktree right now. If any conflict markers
                (<code>{'<<<<<<<'}</code>, <code>{'======='}</code>, <code>{'>>>>>>>'}</code>) are still in the file, they are staged too.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  void handleConfirmResolve()
                }}
              >
                Mark as resolved
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
