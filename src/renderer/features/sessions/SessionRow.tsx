import { memo } from 'react'
import type { ReactNode } from 'react'
import { useSessionListStore } from '@/state'
import { useEnterOnAppear } from '@/components/useEnterOnAppear'
import { HiddenMarker } from './HiddenMarker'
import { EllipsisVerticalIcon, FolderGit2Icon, RotateCwIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { ArchiveParentDialog } from './ArchiveParentDialog'
import { focusSessionsNav } from '@/lib/focus'
import { useMinuteTick } from '@/lib/useMinuteTick'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/components/ui/composerFocus'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { SessionDetailsCard } from './SessionDetailsCard'
import { describeStartProgress, describeStartProgressLabel } from './startProgressDisplay'
import { StateIcon, displayLabel, displayStatus, formatRelativeTimeShort } from './sessionDisplay'
import { useSessionRowActions } from './useSessionRowActions'
import { useSessionRowActivity } from './useSessionRowActivity'
import { SessionAgentsButton } from './SessionAgentsButton'
import { SessionRowTable } from './SessionRowTable'
import {
  ContextActionItems,
  DropdownActionItems,
  SessionRenameInput,
  onContextMenuOpenChange,
  onDropdownOpenChange
} from './SessionRowParts'
import { fromLabelText, type FromLabel } from './sessionTree'
import type { SessionRowSurface } from './sessionRowSurface'
import {
  TreeFromLine,
  TreeLineTwo,
  TreeToggle,
  hasTreeChildren,
  treeDescription,
  treeItemAttributes,
  treeNamePart,
  treeOpenButtonId
} from './SessionRowTree'
import type { SessionRowTreeProps } from './SessionRowTree'
import { IconButton } from '@/components/IconButton'
import { SessionConversationTree } from './SessionConversationTree'
import { hasConversationList } from './conversationTreeFocus'

// The menu trigger stays in the DOM and focusable (opacity/pointer-events swap, overlaid on the time cell under
// hover:hover) because a `hidden` trigger can't take focus, stranding keyboard close paths. `group-has[...]`
// catches Shift+F10's context menu, which sets `data-state` not `aria-expanded`. Under hover:none it is static,
// visible and tappable beside the time, so both show.
const ROW_ACTION_HOVER_CLASS =
  'text-muted-foreground hover:bg-sidebar-border dark:hover:bg-sidebar-border hover:text-foreground'
const TRAILING_MENU_BUTTON_CLASS = cn(
  'opacity-0 pointer-events-none',
  ROW_ACTION_HOVER_CLASS,
  'aria-expanded:bg-sidebar-border',
  '[@media(hover:hover)]:absolute [@media(hover:hover)]:top-1/2 [@media(hover:hover)]:-translate-y-1/2 [@media(hover:hover)]:right-0',
  '[@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto',
  '[@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-focus-within:pointer-events-auto',
  '[@media(hover:hover)]:group-has-[[aria-expanded="true"]]:opacity-100',
  '[@media(hover:hover)]:group-has-[[aria-expanded="true"]]:pointer-events-auto',
  '[@media(hover:hover)]:group-has-[[data-slot="context-menu-trigger"][data-state="open"]]:opacity-100',
  '[@media(hover:hover)]:group-has-[[data-slot="context-menu-trigger"][data-state="open"]]:pointer-events-auto',
  'focus-visible:opacity-100 focus-visible:pointer-events-auto',
  '[@media(hover:none)]:static [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto',
  COMPOSER_BUTTON_FOCUS_CLASS
)
// The time cell sizes the trailing slot under hover:hover; `invisible` (not `hidden`) keeps its box so the swap never resizes.
const TRAILING_TIME_CLASS = cn(
  'text-xs tabular-nums text-muted-foreground',
  '[@media(hover:hover)]:group-hover:invisible [@media(hover:hover)]:group-focus-within:invisible',
  '[@media(hover:hover)]:group-has-[[aria-expanded="true"]]:invisible',
  '[@media(hover:hover)]:group-has-[[data-slot="context-menu-trigger"][data-state="open"]]:invisible'
)

/** The row's line 2 is one slot; the first match wins (#567). */
function lineTwoKind(
  session: SessionSummary,
  activityText: string | null,
  deleting: boolean
): 'deleting' | 'start-progress' | 'terminated' | 'archived' | 'activity' | 'branch' {
  if (deleting) return 'deleting'
  if (session.startProgress) return 'start-progress'
  const terminated =
    session.status === 'stopped' &&
    session.terminatedUnexpectedly &&
    session.stopReason !== 'worktree-missing' &&
    session.stopReason !== 'start-failed'
  if (terminated) return 'terminated'
  if (session.archivedAt) return 'archived'
  if (activityText && (session.status === 'working' || session.status === 'needs-you')) return 'activity'
  return 'branch'
}

export type SessionRowProps =
  // `repository` is absent for the Personal Agent, which belongs to no Project.
  // `from` is the "from <parent>" line of a top-level row in a group that draws no tree (#1862); a tree row's own line comes from `tree`.
  | { layout?: 'list'; session: SessionSummary; repository?: Repository; tree?: SessionRowTreeProps; from?: FromLabel | null; children?: ReactNode }
  // The table layout renders this row on Manage sessions (#934); `surface` supplies its focus, announcement
  // and open behaviour, and `repository` is `undefined` when the Project can't be resolved.
  | { layout: 'table'; session: SessionSummary; repository: Repository | undefined; projectName: string; surface: SessionRowSurface }

export const SessionRow = memo(function SessionRow(props: SessionRowProps) {
  const { session } = props
  const row = useSessionRowActions(
    session,
    props.repository,
    props.layout === 'table' ? props.surface : undefined,
    props.layout === 'table' ? undefined : props.tree
  )
  const {
    isVisible, isFocusedPane, isSplitOpen, replaceFocused, openInSplit, open, deleting,
    renaming, deleteOpen, setDeleteOpen, resuming,
    resumeButtonRef, worktreeMissing, rowRef, openButtonRef, menuTriggerRef,
    focusListContainer, startRenaming, canResume, handleResume,
    handleOpenButtonKeyDown,
    actions, handleMenuCloseAutoFocus
  } = row
  useEnterOnAppear(rowRef, session.createdAt)

  // One shared app-level tick forces the once-a-minute re-render for the relative time text.
  useMinuteTick()

  const runningAgents = session.status === 'stopped' ? 0 : (session.activity?.runningSubagents ?? 0)
  const activityText = useSessionRowActivity(session)
  if (props.layout === 'table') {
    return <SessionRowTable session={session} projectName={props.projectName} surface={props.surface} row={row} />
  }
  const { repository } = props
  const fg = isVisible ? 'text-session-row-selected-fg' : 'text-session-row-fg'
  const metaFg = isVisible ? 'text-session-row-selected-fg' : 'text-session-row-meta-fg'
  const lineTwo = lineTwoKind(session, activityText, deleting)
  // "focused pane" is announced only while a Split is open; in a single pane it repeats `aria-current`.
  const accessibleName = [
    session.name,
    session.startProgress ? describeStartProgressLabel(session.startProgress.kind) : displayLabel(session),
    session.archivedAt ? 'Archived' : null,
    session.hiddenAt ? 'Hidden' : null,
    isSplitOpen && isFocusedPane ? 'focused pane' : null,
    props.tree ? treeNamePart(props.tree) : null,
    deleting ? 'deleting' : null
  ]
    .filter((part): part is string => Boolean(part))
    .join(', ')
  // An archived row's line 2 is the Project name, which the hover card doesn't expose to screen readers
  // and which tells rows apart in the cross-Project Archived list (#527).
  const activityDescription = [
    lineTwo === 'start-progress' && session.startProgress
      ? describeStartProgress(session.startProgress)
      : lineTwo === 'terminated'
        ? 'Terminated unexpectedly'
        : lineTwo === 'archived'
          ? (repository?.name ?? '')
          : lineTwo === 'activity'
            ? (activityText ?? undefined)
            : undefined,
    // The count and the "from" line are in the sr-only description, not the name, so the name stays short (FR-008).
    props.tree ? treeDescription(props.tree) : props.from ? fromLabelText(props.from) : null
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ') || undefined

  const { tree, children } = props
  const from = tree ? tree.from : props.from
  const parentTree = tree && hasTreeChildren(tree) ? tree : null
  // A parent's count shares line 2 with the slot, so the slot drops its own indent there.
  const linePad = parentTree ? undefined : 'pl-6'
  // A collapsed parent takes the open-Session state while a hidden descendant is the selected Session.
  const showSelected = isVisible || Boolean(tree?.selectedBelow && !tree.open)
  const lineTwoSlot =
    lineTwo === 'deleting' ? (
      <span className={cn('truncate text-xs', linePad, metaFg)}>Deleting…</span>
    ) : lineTwo === 'start-progress' && session.startProgress ? (
      <span className={cn('truncate text-xs', linePad, metaFg)} aria-hidden>
        {describeStartProgress(session.startProgress)}
      </span>
    ) : lineTwo === 'terminated' ? (
      <span className={cn('truncate text-xs text-destructive', linePad)}>Terminated unexpectedly</span>
    ) : lineTwo === 'archived' ? (
      <span className={cn('flex min-w-0 items-center gap-1 text-xs', linePad, metaFg)}>
        <FolderGit2Icon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{repository?.name}</span>
      </span>
    ) : lineTwo === 'activity' ? (
      <span data-testid="session-activity-line" className={cn('truncate text-xs', linePad, session.status === 'needs-you' ? fg : metaFg)}>
        {activityText}
      </span>
    ) : (
      session.branch && <span className={cn('truncate font-code text-xs', linePad, metaFg)}>{session.branch}</span>
    )
  const lineTwoNode = parentTree ? <TreeLineTwo tree={parentTree} metaFg={metaFg} slot={lineTwoSlot} /> : lineTwoSlot

  const body = (
    <>
      {showSelected && <ActiveIndicatorBar />}
      <ContextMenu onOpenChange={(open) => onContextMenuOpenChange(row, open)}>
        <ContextMenuTrigger asChild disabled={deleting}>
          <div
            className={cn(
              'relative flex w-full min-h-11 items-start gap-1 pr-2 py-1',
              tree ? 'pl-[calc(1.5rem+var(--tree-indent,0px))]' : 'pl-6',
              deleting && 'opacity-60',
              showSelected ? 'bg-session-row-selected-bg text-session-row-selected-fg' : !deleting && 'hover:bg-session-row-hover-bg'
            )}
          >
            {parentTree && (
              <TreeToggle
                name={session.name}
                sessionId={session.id}
                open={parentTree.open}
                onToggle={() => useSessionListStore.getState().toggleParent(session.id)}
                onKeyDown={row.handleTreeKeyDown}
              />
            )}
            {renaming ? (
              <SessionRenameInput row={row} />
            ) : (
              <SessionDetailsCard
                session={session}
                repository={repository}
                worktreeMissing={worktreeMissing}
                activityDescription={activityDescription}
                activityText={lineTwo === 'activity' ? activityText : null}
              >
                <button
                  ref={openButtonRef}
                  type="button"
                  id={tree ? treeOpenButtonId(session.id) : undefined}
                  aria-current={isVisible ? 'true' : undefined}
                  aria-label={accessibleName}
                  aria-disabled={deleting || undefined}
                  onClick={(event) => {
                    if (deleting) return
                    if (event.ctrlKey) {
                      openInSplit(session.id)
                      return
                    }
                    replaceFocused(session.id)
                    if (isFocusedPane) void open(session.id)
                  }}
                  onDoubleClick={deleting ? undefined : startRenaming}
                  onKeyDown={handleOpenButtonKeyDown}
                  data-choice-item
                  // Query target for `focusSessionRow` so closing the only open pane returns focus here (#621).
                  data-session-open={session.id}
                  className="session-open-button flex min-w-0 flex-1 flex-col gap-0 text-left focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                >
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-2',
                      runningAgents > 0
                        ? canResume
                          ? 'pr-28'
                          : 'pr-20 [@media(hover:none)]:pr-18'
                        : canResume
                          ? 'pr-18 [@media(hover:none)]:pr-24'
                          : 'pr-10 [@media(hover:none)]:pr-18'
                    )}
                  >
                    {deleting || session.startProgress ? (
                      <Spinner className="size-4 shrink-0" />
                    ) : (
                      <StateIcon status={displayStatus(session)} />
                    )}
                    <span className={cn('truncate text-sm font-normal', session.hiddenAt ? metaFg : fg)}>{session.name}</span>
                    {session.hiddenAt && <HiddenMarker compact />}
                  </span>
                  {lineTwoNode}
                  {from && <TreeFromLine from={from} metaFg={metaFg} />}
                </button>
              </SessionDetailsCard>
            )}
            <span role="status" className="sr-only">
              {deleting ? `Deleting ${session.name}…` : resuming ? `Resuming ${session.name}…` : ''}
            </span>
            {!deleting && <span className="absolute right-2 top-0.5 flex h-6 items-center gap-1">
              {canResume && (
                <IconButton
                  ref={resumeButtonRef}
                  size="icon-xs"
                  label={`Resume ${session.name}`}
                  aria-disabled={resuming || undefined}
                  className={cn('aria-disabled:opacity-50', ROW_ACTION_HOVER_CLASS, COMPOSER_BUTTON_FOCUS_CLASS)}
                  onClick={() => void handleResume()}
                >
                  {resuming ? (
                    <Spinner className="size-4" />
                  ) : (
                    <RotateCwIcon aria-hidden className="size-4" />
                  )}
                </IconButton>
              )}
              <SessionAgentsButton
                sessionId={session.id}
                sessionName={session.name}
                running={runningAgents}
                onSelect={() => {
                  replaceFocused(session.id)
                  if (isFocusedPane) void open(session.id)
                }}
                className={ROW_ACTION_HOVER_CLASS}
              />
              <span className="relative flex min-h-4 min-w-6 shrink-0 items-center justify-end gap-1">
                <span aria-hidden className={cn(TRAILING_TIME_CLASS, runningAgents > 0 && '[@media(hover:none)]:hidden')}>
                  {formatRelativeTimeShort(session.lastActivityAt)}
                </span>
                <DropdownMenu onOpenChange={(open) => onDropdownOpenChange(row, open)}>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      ref={menuTriggerRef}
                      size="icon-xs"
                      label={`More actions for ${session.name}`}
                      className={TRAILING_MENU_BUTTON_CLASS}
                    >
                      <EllipsisVerticalIcon aria-hidden className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="max-w-80" onCloseAutoFocus={handleMenuCloseAutoFocus}>
                    <DropdownActionItems actions={actions} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </span>}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-w-80" onCloseAutoFocus={(event) => handleMenuCloseAutoFocus(event, true)}>
          <ContextActionItems actions={actions} />
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
      <ArchiveParentDialog controls={row.archiveDialog} />
    </>
  )
  // Selecting a Conversation selects its Session the way a click on the row does.
  const conversations =
    hasConversationList(session) && !deleting ? (
      <SessionConversationTree
        session={session}
        onSelect={() => {
          replaceFocused(session.id)
          if (isFocusedPane) void open(session.id)
        }}
      />
    ) : null
  if (!tree && !conversations) {
    return (
      <li ref={rowRef} data-choice-item className="group relative w-full">
        {body}
      </li>
    )
  }
  // The tree item is the `<li>`, but hover, the active bar and the menu's `group-has` rules must stop at
  // this Session's own row, so `group` sits on an inner element and the nested lists sit beside it.
  return (
    <li ref={rowRef} data-choice-item className="relative w-full" {...(tree ? treeItemAttributes(tree, session.id) : {})}>
      <div className="group relative w-full">{body}</div>
      {conversations}
      {children}
    </li>
  )
})
