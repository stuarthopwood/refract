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
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { SessionDetailsCard } from './SessionDetailsCard'
import { describeStartProgress, describeStartProgressLabel } from './startProgressDisplay'
import { STATUS_LABEL, StateIcon, displayStatus, formatRelativeTime } from './sessionDisplay'
import { useSessionRowActions } from './useSessionRowActions'

export function SessionRow({
  session,
  repository,
  showRepository
}: {
  session: SessionSummary
  repository: Repository
  // Issue #527 (UX consult): true only for a row rendered inside the new cross-repository
  // Archived group, where the repository is no longer implied by the surrounding group alone --
  // shows the repository name as a secondary label and marks the row "Archived" in its
  // accessible name, instead of relying on the row's position (the issue's own accessibility
  // note: never rely on position alone to say a Session is archived).
  showRepository?: boolean
}) {
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

  return (
    <li ref={rowRef} className="group relative w-full rounded-md">
      {isVisible && (
        <span aria-hidden className="absolute inset-y-0.5 left-0 z-10 w-0.5 rounded-full bg-active-indicator" />
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
          {/* The whole row is one card surface (DESIGN.md "Square choice items"): this div, not
              the open button alone, carries the hover/selected background, so the "..." trigger
              reads as part of the same card rather than sitting past its edge. Full width of its
              <li>, no leftover gutter. No `rounded-md` here: the selected session row is one of
              the square-choice-item surfaces, and this div (not `data-choice-item`'s button) is
              the one actually painting that background, so it must stay square-cornered too. */}
          <div
            className={cn(
              'flex w-full items-center gap-2',
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
                className="w-full min-w-0 flex-1 rounded border border-ring bg-transparent px-2 py-1.5 text-sm outline-none"
              />
            ) : (
              <SessionDetailsCard session={session} repository={repository} worktreeMissing={worktreeMissing}>
                <button
                  ref={openButtonRef}
                  type="button"
                  aria-current={isVisible ? 'true' : undefined}
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
                  className="session-open-button flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 pl-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {/* Gate-fixes a11y Low finding (cycle 5): the row kept showing the 'stopped'
                      icon and label while `session.startProgress` was set (the live-starting
                      kind-based text further down is `sr-only`/`aria-hidden` only, no icon or
                      visible label change), so the accessible name read "Stopped … Starting
                      agent" -- two contradicting status words for the same row. */}
                  {session.startProgress ? (
                    <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <StateIcon status={displayStatus(session)} />
                  )}
                  {/* Gate-fixes a11y Low finding (cycle 6): `describeStartProgressLabel` covers
                      'memory-deferred' too (previously hand-coded as only 'queued' vs
                      'Starting agent', silently misreporting "Starting agent" while the visible
                      text below says "waiting for memory to free up"). */}
                  <span className="sr-only">
                    {session.startProgress ? describeStartProgressLabel(session.startProgress.kind) : STATUS_LABEL[displayStatus(session)]}
                  </span>
                  {isSplitOpen && isVisible && (
                    <span className="sr-only">{isFocusedPane ? '(focused pane)' : '(shown, unfocused pane)'}</span>
                  )}
                  {/* Issue #527 accessibility note: the Archived group's own flat cross-
                      repository list must not rely on position alone to say a Session is
                      archived. */}
                  {session.archivedAt && <span className="sr-only">Archived</span>}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{session.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{session.branch}</span>
                    {showRepository && (
                      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
                        <span className="truncate" title={repository.name}>{repository.name}</span>
                      </span>
                    )}
                    {session.startProgress ? (
                      // Issue #512 requirement 1: the Session row's own "Starting agent... N s"
                      // (the chat pane's banner carries the Keep waiting/Cancel buttons; this row
                      // just needs the live text, shown instead of the stale "Terminated
                      // unexpectedly" note underneath while a fresh start is already under way).
                      // Gate-fixes a11y finding: this span sits inside the row's open `<button>`,
                      // so a ticking visible name would re-speak the whole row every second while
                      // it has focus. `aria-hidden` keeps the tick visible-only -- the row's own
                      // static accessible name (above) already covers the static status word, so
                      // (gate-fixes a11y Low finding, cycle 6) this no longer repeats it in a
                      // second `sr-only` span, which spoke the status twice for the same row.
                      <span className="truncate text-xs text-muted-foreground" aria-hidden>
                        {describeStartProgress(session.startProgress)}
                      </span>
                    ) : (
                      // Quality-gate fix (cycle 6, 2026-10-08, code-reviewer, Low): mirrors ChatPane's
                      // `showTerminatedTitle` -- `worktree-missing`/`start-failed` have their own
                      // dedicated reason text and actions, so this row must not also claim the
                      // session "Terminated unexpectedly" for those two reasons.
                      session.status === 'stopped' &&
                      session.terminatedUnexpectedly &&
                      session.stopReason !== 'worktree-missing' &&
                      session.stopReason !== 'start-failed' && (
                        <span className="truncate text-xs text-destructive">Terminated unexpectedly</span>
                      )
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
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
                    size="icon-sm"
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
                <button
                  ref={menuTriggerRef}
                  type="button"
                  aria-label={`${session.name} actions`}
                  className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-border hover:text-foreground focus:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
                >
                  <EllipsisVerticalIcon aria-hidden className="size-3.5" />
                </button>
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
