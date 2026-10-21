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
import { CheckIcon, Code2Icon, EllipsisVerticalIcon, EyeIcon, Loader2Icon, MinusIcon, PlusIcon } from 'lucide-react'
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
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
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
  // Item 3 (#1101): a per-row in-flight flag -- set before the store call, cleared in a
  // `finally`, local component state (mirrors the Commit button's own `committing` pattern,
  // GitCommitBox.tsx, the state-location convention #1093's own Low item flags for that button
  // -- this follows the SAME pattern rather than inventing a second one). Guards the kebab
  // menu's Stage/Unstage/Mark-as-resolved items against a double click while a round trip is
  // already in flight, and swaps the row's own status icon for a spinner so there is a visible
  // cue even after the menu itself has closed (a `DropdownMenuItem`'s `onSelect` always closes
  // its menu, so the spinner cannot live inside the vanished menu item).
  const [actionPending, setActionPending] = useState(false)

  // Item 7 (gate round 1): after a single-file stage/unstage (or a conflict's own "mark as
  // resolved", which is a stage under the hood), focus the SAME row again wherever it ended up
  // (it may have moved to a different group) -- falling back to the nearest surviving group
  // trigger only in the rare case the row cannot be found anywhere afterward. Gate round 3 fix
  // (#1076 MEDIUM b, UI review): gated on the action's own directly-returned result -- a FAILED
  // stage/unstage must never move focus away from the control the developer just activated
  // (the kebab item stays in place, same as the group's own bulk-action already did).
  // #1111 gate round 2 MEDIUM 7: a failed stage/unstage's own round trip can take long enough
  // that the developer has ALREADY moved focus elsewhere (e.g. typing in the Commit subject
  // field) by the time it settles -- unconditionally refocusing the kebab here would steal it
  // back. Only restores focus if it's still sitting on `<body>` (nothing else claimed it) or
  // already on this SAME kebab trigger (a no-op either way).
  function restoreKebabFocusIfStillOwed(): void {
    const active = document.activeElement
    if (active === document.body || active === kebabTriggerRef.current) kebabTriggerRef.current?.focus()
  }

  async function handleStage(): Promise<void> {
    if (actionPending) return
    setActionPending(true)
    // Item 3 (#1101): the existing app-level `role="status"` region (`chatAreaAnnouncer.ts`,
    // mounted once in `App.tsx`, survives this row remounting across a group move) covers the
    // screen-reader side of the in-progress state -- no new live region.
    useChatAreaAnnouncer.getState().announce(`Staging ${fileName}…`)
    try {
      const result = await useGitChangesStore.getState().stage(sessionId, [entry.path])
      if (result.ok) {
        useChatAreaAnnouncer.getState().announce(`Staged ${fileName}`)
        if (!focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
      } else {
        // #1111 item 2: a failed stage never moves the row to a new group, so the SAME kebab
        // trigger is still mounted right here -- explicit, rather than relying solely on
        // Radix's own close-autofocus (which now succeeds too, since the trigger below is
        // never natively `disabled` anymore, but this is the belt-and-braces restore the fix
        // calls for).
        restoreKebabFocusIfStillOwed()
      }
    } finally {
      setActionPending(false)
    }
  }

  async function handleUnstage(): Promise<void> {
    if (actionPending) return
    setActionPending(true)
    useChatAreaAnnouncer.getState().announce(`Unstaging ${fileName}…`)
    try {
      const result = await useGitChangesStore.getState().unstage(sessionId, [entry.path])
      if (result.ok) {
        useChatAreaAnnouncer.getState().announce(`Unstaged ${fileName}`)
        if (!focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
      } else {
        restoreKebabFocusIfStillOwed()
      }
    } finally {
      setActionPending(false)
    }
  }

  async function handleConfirmResolve(): Promise<void> {
    setConfirmResolveOpen(false)
    await handleStage()
  }

  return (
    <div className="group/row flex w-full items-center gap-1.5 rounded px-1 py-1 text-sm hover:bg-accent/50" aria-busy={actionPending}>
      <button
        type="button"
        data-git-row-path={entry.path}
        onClick={onOpenDiff}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        {/* Item 3 (#1101): the row's own status icon becomes a spinner while a stage/unstage
            round trip for THIS file is in flight -- the kebab menu that triggered it has
            already closed (a `DropdownMenuItem`'s `onSelect` always closes its menu), so the
            row itself is the only place left to show it. */}
        {actionPending ? (
          <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <mark.Icon aria-hidden className={`size-3.5 shrink-0 ${mark.className}`} />
        )}
        <span className="sr-only">{`${mark.label} — Open diff for ${entry.path}`}</span>
        <span aria-hidden className="min-w-0 flex-1 truncate" title={entry.path}>
          {fileName}
          {entry.folder && <span className="ml-1.5 text-xs text-muted-foreground">{entry.folder}</span>}
        </span>
      </button>
      <DiffStatCounts added={entry.additions} removed={entry.deletions} compact accessibleLabel />
      {/* Gate round 2 item 12: "(partial)" read as "partially staged" now that a genuinely
          partially staged (MM) file is its own real concept in this panel (gate round 1 item 5)
          -- this badge means something unrelated: the additions/deletions count itself hit the
          `MAX_FILES`/per-file byte cap and stopped short, not that the STAGE state is split. */}
      {entry.partial && <span className="shrink-0 text-xs text-muted-foreground">(counts capped)</span>}
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
            aria-disabled={actionPending || undefined}
            // #1111 item 2 fix: a NATIVE `disabled` means the browser forces a blur the moment
            // React applies it mid-flight, and `.focus()` is then a no-op on a disabled element
            // -- both this control's own close-autofocus AND the explicit restores above used
            // to land on a disabled, unfocusable button and fall through to `<body>` (a WCAG
            // 2.4.3 regression this comment used to wrongly claim never happened). Fixed: the
            // trigger stays natively focusable always; `onKeyDown` below calls
            // `preventDefault()` on only the keys Radix itself treats as "activate/open this
            // trigger" (Enter, Space, ArrowDown, ArrowUp) while pending, which Radix's own
            // `composeEventHandlers` honours by skipping its internal toggle on a
            // default-prevented event -- so the menu still never opens mid-flight, without ever
            // disabling the element itself. Gate round 2 HIGH 4 fix: the round-1 version called
            // `preventDefault()` on EVERY key while pending, including Tab/Shift+Tab -- a WCAG
            // 2.1.2 keyboard trap (focus could never leave this control by keyboard while a
            // stage/unstage was in flight). No `onPointerDown` guard is needed: `aria-disabled:
            // pointer-events-none` in the className below already stops the browser from
            // dispatching any pointer event to this element at all while pending.
            onKeyDown={(event) => {
              if (actionPending && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp')) event.preventDefault()
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100 aria-disabled:pointer-events-none aria-disabled:opacity-50"
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
            // #1111 item 2: this already called `kebabTriggerRef.current?.focus()` on close,
            // but used to land on a trigger the row's own re-render could have just made
            // natively `disabled` (the dialog closes synchronously before `handleStage`'s own
            // `actionPending` flip settles) -- a no-op there too. Fixed at the trigger itself
            // (no native `disabled` anymore), so this same call now always succeeds.
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
