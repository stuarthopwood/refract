import { EllipsisVerticalIcon, FolderGit2Icon, LoaderCircleIcon, RotateCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { focusSessionsNav } from '@/lib/focus'
import { useMinuteTick } from '@/lib/useMinuteTick'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { SessionDetailsCard } from './SessionDetailsCard'
import { describeStartProgress, describeStartProgressLabel } from './startProgressDisplay'
import { STATUS_LABEL, StateIcon, displayStatus, formatRelativeTimeShort } from './sessionDisplay'
import { useSessionRowActions } from './useSessionRowActions'

// #567 decision 12: the row's own trailing "..." menu button shares the time's slot -- hidden at
// rest, taking over the instant the row is hovered, has focus inside it, or its own menu is
// open, and both shown together under `(hover: none)` (a touch pointer has no hover to reveal
// it). `group-has-[[aria-expanded="true"]]` catches either the context menu or the dropdown menu
// opening, since Radix sets `aria-expanded` on whichever trigger owns the open menu.
const TRAILING_MENU_BUTTON_CLASS = cn(
  'hidden text-muted-foreground hover:bg-sidebar-border hover:text-foreground',
  'group-hover:inline-flex group-focus-within:inline-flex group-has-[[aria-expanded="true"]]:inline-flex',
  '[@media(hover:none)]:inline-flex'
)
const TRAILING_TIME_CLASS = cn(
  'ml-auto shrink-0 text-xs tabular-nums text-muted-foreground',
  'group-hover:hidden group-focus-within:hidden group-has-[[aria-expanded="true"]]:hidden',
  '[@media(hover:none)]:block'
)

/** #567 decision 9: the row's line 2 is one slot; the first match among these wins. #526
 *  (activity text while working or needs-you) and #748 (a hidden row) both land after #567 and
 *  fill in their own case here -- neither exists yet, so this never returns them. */
function lineTwoKind(session: SessionSummary): 'start-progress' | 'terminated' | 'archived' | 'branch' {
  if (session.startProgress) return 'start-progress'
  const terminated =
    session.status === 'stopped' &&
    session.terminatedUnexpectedly &&
    session.stopReason !== 'worktree-missing' &&
    session.stopReason !== 'start-failed'
  if (terminated) return 'terminated'
  if (session.archivedAt) return 'archived'
  return 'branch'
}

export function SessionRow({ session, repository }: { session: SessionSummary; repository: Repository }) {
  const {
    isVisible, isFocusedPane, replaceFocused, openInSplit, open,
    renaming, draftName, setDraftName, deleteOpen, setDeleteOpen, resuming,
    resumeButtonRef, worktreeMissing, rowRef, openButtonRef, menuTriggerRef, renameInputRef,
    createRequestedRef, createOriginRef, contextMenuOpenerRef,
    settledCreateRef, settledRestoreRef, restoreRequestedRef,
    focusListContainer, startRenaming, canResume, handleResume,
    commitRename, handleNameKeyDown, handleOpenButtonKeyDown,
    actions, handleMenuCloseAutoFocus
  } = useSessionRowActions(session, repository)

  // #567 decision 11: one shared app-level tick instead of a timer per row -- this row's own
  // time text (`formatRelativeTimeShort` below) is recomputed on every render, and this is the
  // one thing that forces a render once a minute even when nothing else about the row changed.
  useMinuteTick()

  const lineTwo = lineTwoKind(session)
  // #567 decision 16: "{name}, {status word}[, Archived][, focused pane]" -- the row's whole
  // accessible name, replacing the scattered `sr-only` spans this button used to carry (their
  // bracketed, position-dependent text is gone; `isVisible && !isFocusedPane`, the previous
  // "shown, unfocused pane" case, is dropped, since the decision's own name formula has no slot
  // for it and the pane's Focused badge already marks which pane is focused).
  const statusWord = session.startProgress
    ? describeStartProgressLabel(session.startProgress.kind)
    : STATUS_LABEL[displayStatus(session)]
  const accessibleName = [session.name, statusWord, session.archivedAt ? 'Archived' : null, isFocusedPane ? 'focused pane' : null]
    .filter((part): part is string => Boolean(part))
    .join(', ')
  // #567 decision 16: "the activity text (when line 2 is not the branch)" leads the card's own
  // accessible description (`SessionDetailsCard.tsx`) -- the archived case needs none of its own,
  // since the project name it shows on line 2 duplicates that card's existing repository line.
  const activityDescription =
    lineTwo === 'start-progress' && session.startProgress
      ? describeStartProgress(session.startProgress)
      : lineTwo === 'terminated'
        ? 'Terminated unexpectedly'
        : undefined

  return (
    <li ref={rowRef} data-choice-item className="group relative w-full">
      {isVisible && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-full bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]"
        />
      )}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) return
          // A11y-review fix (gate round 4, Low): reopening this menu while a previous create's
          // settle is still stashed means Radix's own close-autofocus for that earlier close may
          // never fire at all (superseded by this new open) -- run it now, before overwriting
          // `createOriginRef` for this new open, so the stashed `finish` still resolves the
          // origin it actually belongs to.
          const settled = settledCreateRef.current
          settledCreateRef.current = null
          createRequestedRef.current = false
          settled?.()
          // Gate round 2 fix (Low): mirrors the create cleanup above -- reopening this menu
          // while a previous restore's own settle is still stashed means Radix's close-
          // autofocus for that earlier close may never fire again; run it now, before this new
          // open can overwrite anything it reads.
          const settledRestore = settledRestoreRef.current
          settledRestoreRef.current = null
          restoreRequestedRef.current = false
          settledRestore?.()
          createOriginRef.current = 'context'
          // A11y-review fix (gate round 2, LOW): Shift+F10/the Menu key opens this menu from
          // whatever element already has focus (for example the "..." trigger itself), not
          // always the row's open button -- prefer that element when it is genuinely inside
          // this row.
          const active = document.activeElement
          contextMenuOpenerRef.current = active instanceof HTMLElement && rowRef.current?.contains(active) ? active : null
        }}
      >
        <ContextMenuTrigger asChild>
          {/* #567 decision 8: the whole row is one 44px two-line card surface, square-cornered
              (`data-choice-item` on the `<li>` above, FR-054) -- this div, not the open button's
              own `data-choice-item`, is the one actually painting the hover/selected background,
              so it carries the row's own padding too. */}
          <div
            className={cn(
              'flex w-full items-center gap-1 pl-3 pr-2 py-1',
              isVisible ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent'
            )}
          >
            {renaming ? (
              <input
                ref={renameInputRef}
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={handleNameKeyDown}
                aria-label="Session name"
                className="w-full min-w-0 flex-1 rounded border border-ring bg-transparent px-2 py-1 text-sm outline-none"
              />
            ) : (
              <SessionDetailsCard
                session={session}
                repository={repository}
                worktreeMissing={worktreeMissing}
                activityDescription={activityDescription}
              >
                <button
                  ref={openButtonRef}
                  type="button"
                  aria-current={isVisible ? 'true' : undefined}
                  aria-label={accessibleName}
                  // Spec 005 (FR-001, FR-008, FR-009, data-model.md transition table): Ctrl+click
                  // always opens a split (or replaces the unfocused pane / focuses it, per
                  // `openInSplit`'s own rules). A plain click on the already-focused pane's own
                  onClick={(event) => {
                    if (event.ctrlKey) {
                      openInSplit(session.id)
                      return
                    }
                    replaceFocused(session.id)
                    if (isFocusedPane) void open(session.id)
                  }}
                  onDoubleClick={startRenaming}
                  onKeyDown={handleOpenButtonKeyDown}
                  data-choice-item
                  // Issue #621 (close chat pane): a stable query target for `focusSessionRow`
                  // (lib/focus.ts) so closing this Session's only open pane can return focus
                  // here first, before falling back further to the Sessions nav itself.
                  data-session-open={session.id}
                  className="session-open-button flex min-w-0 flex-1 flex-col gap-0 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                >
                  {/* #567 decision 8: line 1 -- the state icon (16px), the title (truncates),
                      then the time at the right (decision 12's trailing slot, swapped for the
                      "..." menu button on hover/focus/open-menu). */}
                  <span className="flex min-w-0 items-center gap-2">
                    {session.startProgress ? (
                      <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <StateIcon status={displayStatus(session)} />
                    )}
                    <span className="truncate text-sm font-normal text-sidebar-foreground">{session.name}</span>
                    <span aria-hidden className={TRAILING_TIME_CLASS}>
                      {formatRelativeTimeShort(session.lastActivityAt)}
                    </span>
                  </span>
                  {/* Line 2: one slot, first match wins (`lineTwoKind` above). */}
                  {lineTwo === 'start-progress' && session.startProgress ? (
                    <span className="truncate pl-6 text-xs text-muted-foreground" aria-hidden>
                      {describeStartProgress(session.startProgress)}
                    </span>
                  ) : lineTwo === 'terminated' ? (
                    <span className="truncate pl-6 text-xs text-destructive">Terminated unexpectedly</span>
                  ) : lineTwo === 'archived' ? (
                    <span className="truncate pl-6 text-xs text-muted-foreground">{repository.name}</span>
                  ) : (
                    <span className="truncate pl-6 font-code text-xs text-muted-foreground">{session.branch}</span>
                  )}
                </button>
              </SessionDetailsCard>
            )}
            {/* Quality-gate fix (a11y, cycle 2, 2026-10-08): moved out of the Button -- a
                `role="status"` element nested inside a `<button>` is presentational to ARIA (a
                button's children never form part of the accessibility tree on their own), so it
                was never exposed as a live region at all. Always mounted (never created
                together with its own text, which a screen reader generally fails to announce),
                a sibling of the button, not conditional on `canResume` so it survives past the
                moment the button itself unmounts on a successful resume. */}
            <span role="status" className="sr-only">
              {resuming ? `Resuming ${session.name}…` : ''}
            </span>
            {canResume && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    ref={resumeButtonRef}
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Resume ${session.name}`}
                    aria-disabled={resuming || undefined}
                    className="aria-disabled:opacity-50"
                    onClick={() => void handleResume()}
                  >
                    {resuming ? (
                      <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCwIcon aria-hidden className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Resume {session.name}</TooltipContent>
              </Tooltip>
            )}
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) return
                const settled = settledCreateRef.current
                settledCreateRef.current = null
                createRequestedRef.current = false
                settled?.()
                // Gate round 2 fix (Low): mirrors the create cleanup above -- see the matching
                // ContextMenu comment.
                const settledRestore = settledRestoreRef.current
                settledRestoreRef.current = null
                restoreRequestedRef.current = false
                settledRestore?.()
                createOriginRef.current = 'dropdown'
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  ref={menuTriggerRef}
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${session.name} actions`}
                  className={TRAILING_MENU_BUTTON_CLASS}
                >
                  <EllipsisVerticalIcon aria-hidden className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-w-80" onCloseAutoFocus={handleMenuCloseAutoFocus}>
                {actions.map((action, index) =>
                  action.kind === 'separator' ? (
                    <DropdownMenuSeparator key={`sep-${index}`} />
                  ) : (
                    <DropdownMenuItem
                      key={action.key}
                      variant={action.variant}
                      disabled={action.disabled}
                      onSelect={action.onSelect}
                    >
                      <span className="min-w-0 whitespace-normal break-words">{action.label}</span>
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        {/* Right-click opens the same options the "..." trigger does (T117 new feature): one
            action list, never a second menu to maintain. */}
        <ContextMenuContent className="max-w-80" onCloseAutoFocus={(event) => handleMenuCloseAutoFocus(event, true)}>
          {actions.map((action, index) =>
            action.kind === 'separator' ? (
              <ContextMenuSeparator key={`sep-${index}`} />
            ) : (
              <ContextMenuItem
                key={action.key}
                variant={action.variant}
                disabled={action.disabled}
                onSelect={action.onSelect}
              >
                <span className="min-w-0 whitespace-normal break-words">{action.label}</span>
              </ContextMenuItem>
            )
          )}
        </ContextMenuContent>
      </ContextMenu>
      <DeleteDialog
        session={session}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={focusListContainer}
        onCancelled={() => {
          if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
          else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
          else focusSessionsNav()
        }}
      />
    </li>
  )
}
