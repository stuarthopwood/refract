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
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { SessionDetailsCard } from './SessionDetailsCard'
import { describeStartProgress, describeStartProgressLabel } from './startProgressDisplay'
import { STATUS_LABEL, StateIcon, displayStatus, formatRelativeTimeShort } from './sessionDisplay'
import { useSessionRowActions } from './useSessionRowActions'

// Gate round 1 fix (High, code/a11y/architect): a `hidden` (display:none) trigger can never take
// focus, so every keyboard close path (Escape, a dropdown item, Delete > Cancel, Shift+F10) that
// calls `menuTriggerRef.current.focus()` silently did nothing and stranded focus on `<body>`;
// Shift+Tab also skipped it (decision 17: "every control is a Tab stop"). Kept in the DOM and
// focusable at all times instead: `opacity`/`pointer-events` swap, absolutely positioned over the
// time's own cell (decision 12's "takes that slot") rather than removed from flow. The reveal
// rules are scoped inside `[@media(hover:hover)]` so a touch pointer (no hover at all) never
// engages them -- "Under hover:none, both show" then falls out as the plain, un-hidden default,
// with no separate override needed. `group-has-[[data-slot="context-menu-trigger"][data-state=
// "open"]]` catches Shift+F10's context menu (Radix's `ContextMenuTrigger` sets `data-state`, not
// `aria-expanded`, unlike the dropdown's own trigger).
const TRAILING_MENU_BUTTON_CLASS = cn(
  'absolute inset-y-0 right-0 opacity-0 pointer-events-none text-muted-foreground',
  'hover:bg-sidebar-border dark:hover:bg-sidebar-border hover:text-foreground aria-expanded:bg-sidebar-border',
  '[@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto',
  '[@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-focus-within:pointer-events-auto',
  '[@media(hover:hover)]:group-has-[[aria-expanded="true"]]:opacity-100',
  '[@media(hover:hover)]:group-has-[[aria-expanded="true"]]:pointer-events-auto',
  '[@media(hover:hover)]:group-has-[[data-slot="context-menu-trigger"][data-state="open"]]:opacity-100',
  '[@media(hover:hover)]:group-has-[[data-slot="context-menu-trigger"][data-state="open"]]:pointer-events-auto',
  'focus-visible:opacity-100 focus-visible:pointer-events-auto',
  COMPOSER_BUTTON_FOCUS_CLASS
)
// The time's own cell defines the trailing slot's size; the menu button above overlays it.
// `invisible` (not `hidden`) keeps its layout box reserved, so the slot never resizes when the
// button takes it over. Same `[@media(hover:hover)]`-scoped reveal rules as the button above, so
// the two never disagree about which is showing.
const TRAILING_TIME_CLASS = cn(
  'text-xs tabular-nums text-muted-foreground',
  '[@media(hover:hover)]:group-hover:invisible [@media(hover:hover)]:group-focus-within:invisible',
  '[@media(hover:hover)]:group-has-[[aria-expanded="true"]]:invisible',
  '[@media(hover:hover)]:group-has-[[data-slot="context-menu-trigger"][data-state="open"]]:invisible'
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
    isVisible, isFocusedPane, isSplitOpen, replaceFocused, openInSplit, open,
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
  // Gate round 1 fix (Medium, a11y/architect): "focused pane" is only meaningful while a real
  // Split is open (decision 14 frames it that way; on `main` it was gated on `isSplitOpen` too)
  // -- in a single pane it is noise on every selected row, re-announcing what `aria-current`
  // already says. Restores the `isSplitOpen` gate decision 16's own name formula leaves implicit.
  const accessibleName = [
    session.name,
    session.startProgress ? describeStartProgressLabel(session.startProgress.kind) : STATUS_LABEL[displayStatus(session)],
    session.archivedAt ? 'Archived' : null,
    isSplitOpen && isFocusedPane ? 'focused pane' : null
  ]
    .filter((part): part is string => Boolean(part))
    .join(', ')
  // Gate round 1 fix (High, a11y/code): an archived row's own line 2 (the Project name) was
  // never reaching assistive technology -- `SessionDetailsCard`'s hover card is not reachable by
  // a screen reader (its own comment says so), so leaving this `undefined` dropped the one thing
  // that tells rows apart in the flat, cross-Project Archived list (#527's own accessibility
  // note). Decision 16: "the activity text (when line 2 is not the branch)" leads the
  // description; an archived row's line 2 is the Project name, not the branch.
  const activityDescription =
    lineTwo === 'start-progress' && session.startProgress
      ? describeStartProgress(session.startProgress)
      : lineTwo === 'terminated'
        ? 'Terminated unexpectedly'
        : lineTwo === 'archived'
          ? repository.name
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
              so it carries the row's own padding too. `items-start` (not `items-center`) pins
              Resume and the trailing time/"..." cell to line 1's own height, next to it, instead
              of centring them across the whole 44px row (gate round 1 fix, architect/layout).
              `min-h-11` keeps the row at its full height while renaming (gate round 1 fix, Low:
              a lone `<input>` used to shrink it to about 38px). Row `pl-6` (not the decision's
              own literal `pl-3`): the UX architect's gate ruling on decision 8 changes the
              header trigger to `gap-1 px-1` (`GroupHeader.tsx`) so its own Project icon starts at
              24px, and widens this row to match, so the status icon finally lines up under it. */}
          <div
            className={cn(
              'flex w-full min-h-11 items-start gap-1 pl-6 pr-2 py-1',
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
                  {/* #567 decision 8: line 1 -- the state icon (16px) and the truncating title.
                      The time and the "..." menu button both live in the trailing cell below,
                      OUTSIDE this button, so line 2 (the branch) keeps the full row width on
                      every row, not just the ones without Resume (gate round 1 fix, Medium). */}
                  <span className="flex min-w-0 items-center gap-2">
                    {session.startProgress ? (
                      <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <StateIcon status={displayStatus(session)} />
                    )}
                    <span className="truncate text-sm font-normal text-sidebar-foreground">{session.name}</span>
                  </span>
                  {/* Line 2: one slot, first match wins (`lineTwoKind` above). Gate round 1 fix
                      (Medium, decision 9.4): an archived row's Project name gets the same
                      `FolderGit2Icon size-3` the old per-repository secondary label used. */}
                  {lineTwo === 'start-progress' && session.startProgress ? (
                    <span className="truncate pl-6 text-xs text-muted-foreground" aria-hidden>
                      {describeStartProgress(session.startProgress)}
                    </span>
                  ) : lineTwo === 'terminated' ? (
                    <span className="truncate pl-6 text-xs text-destructive">Terminated unexpectedly</span>
                  ) : lineTwo === 'archived' ? (
                    <span className="flex min-w-0 items-center gap-1 pl-6 text-xs text-muted-foreground">
                      <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
                      <span className="truncate">{repository.name}</span>
                    </span>
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
                    className={cn('aria-disabled:opacity-50', COMPOSER_BUTTON_FOCUS_CLASS)}
                    onClick={() => void handleResume()}
                  >
                    {resuming ? (
                      <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                    ) : (
                      <RotateCwIcon aria-hidden className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Resume {session.name}</TooltipContent>
              </Tooltip>
            )}
            {/* #567 decision 12's trailing slot: the time at rest, the "..." menu button taking
                its place on hover, focus inside the row, or an open menu (gate round 1 fix,
                High: the button used to be removed from flow entirely at rest, which broke
                keyboard focus-return and Shift+Tab -- see the class constants' own comments).
                `relative` so the absolutely-positioned button overlays this cell, not the row. */}
            <span className="relative flex h-4 min-w-6 shrink-0 items-center justify-end">
              <span aria-hidden className={TRAILING_TIME_CLASS}>
                {formatRelativeTimeShort(session.lastActivityAt)}
              </span>
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
                    <EllipsisVerticalIcon aria-hidden className="size-3" />
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
            </span>
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
