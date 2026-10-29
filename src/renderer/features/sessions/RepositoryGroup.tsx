import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { EllipsisVerticalIcon, GitBranchPlusIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'
import { RemoveRepositoryDialog } from '@/features/sessions/RemoveRepositoryDialog'
import { focusRepositoryGroupOrReadiness, focusSessionsNav } from '@/lib/focus'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { notify, useRepositoriesStore, useSessionListStore, useSessionsStore, useSplitStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { ProjectColor, Repository } from '../../../shared/model'
import { validateRepositoryName } from '../../../shared/repositoryName'
import { GroupHeaderTrigger } from './GroupHeader'
import { githubRemoteSlug, remoteHeaderIcon, remoteHeaderTooltip } from './remoteDisplay'
import { ProjectColorPopover } from './ProjectColorPopover'
import { ReportIssueDialog } from './ReportIssueDialog'
import { useSidebarRgb } from './useSidebarRgb'
import { projectColorCss } from '@/lib/projectColor'
import { useFocusSearchOnStrandedUnmount } from './useFocusSearchOnStrandedUnmount'
import { groupWaitingState } from './sessionDisplay'
import { SessionRow } from './SessionRow'

// #567 decision 6: shared by the "+" quick-create, branch picker, and "..." menu buttons below
// -- hidden at rest (kept in the Tab order by opacity, never `hidden`/`display:none`, unlike
// `SessionRow.tsx`'s own trailing-slot swap, which the decision does not ask for here), shown on
// `group-hover`/`group-focus-within` (hovering or focusing anywhere in the header), this
// button's own `aria-expanded` (branch picker, "..." menu), and always under `(hover: none)`.
// The `creating`/`active.length === 0` override (applied per-button below, since only this
// function's own closure has those values) keeps them visible while a Session is being created
// or the group has no active Sessions to hover over in the first place.
//
// Gate round 1 fix (Medium, architect/visual): `variant="ghost"` alone loses `hover:bg-sidebar-
// border` to the Button base's own `dark:hover:bg-muted/50` (every built-in theme sets `.dark`,
// and a `dark:` modifier out-specificities a bare one) -- `--muted` equals `--sidebar-accent` in
// every theme, so a hovered or open-menu button showed no fill at all against a selected row.
// `dark:hover:bg-sidebar-border`/`aria-expanded:bg-sidebar-border` win back the fill the same way
// `SessionList.tsx`'s own `SESSION_LIST_TOOLBAR_BUTTON_CLASS` already does. `COMPOSER_BUTTON_
// FOCUS_CLASS` restores a real forced-colours focus outline: `Button`'s own `focus-visible:
// ring-3` is a box-shadow, which forced colours strips, leaving these controls with no visible
// focus change at all without it.
const HEADER_ACTION_BUTTON_CLASS = cn(
  'text-muted-foreground opacity-0 transition-opacity duration-150',
  'hover:bg-sidebar-border hover:text-foreground dark:hover:bg-sidebar-border aria-expanded:bg-sidebar-border',
  'group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100',
  '[@media(hover:none)]:opacity-100',
  COMPOSER_BUTTON_FOCUS_CLASS
)

export function RepositoryGroup({
  repository,
  sessions
}: {
  repository: Repository
  sessions: SessionSummary[]
}) {
  const createSession = useSessionsStore((state) => state.create)
  // Issue #527: archived Sessions no longer get their own per-repository group here -- they all
  // move into one cross-repository `ArchivedGroup` at the bottom of the list instead. Computed
  // before the hooks below (gate round 1 fix, code-reviewer/a11y/architect HIGH): the marker and
  // the active bar must read only this Repository's own LISTED Sessions (decision 21 says "that
  // group's listed Sessions"), never an archived Session that has already moved to Archived --
  // using the raw `sessions` prop there put a false bar and marker on a Repository header for a
  // Session the group no longer shows at all (confirmed live, gate round 1).
  const active = sessions.filter((session) => !session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  // #735 decisions 15, 21, 22: the persisted open/closed state (replaces `defaultOpen`), the
  // Waiting marker and the visible-Session active bar -- both only shown while closed (decisions
  // 21, 22), never computed or rendered while the group is already open.
  const isOpen = useSessionListStore((state) => state.isGroupOpen(repository.id))
  const containsVisibleSession = useSplitStore((state) => active.some((session) => state.paneSessionIds.includes(session.id)))
  const marker = isOpen ? null : groupWaitingState(active)
  const containsOpenSession = !isOpen && containsVisibleSession
  // Issue #620, UX consult item 2 decision 6: this per-repository in-flight guard used to be a
  // private ref/state pair only this button could see -- it now lives in `sessions-store.ts`,
  // shared with the row's own "New session from {branch}" menu item and `NewSessionDialog`, so
  // `create()` itself enforces the guard and every caller's disabled state agrees. Subscribes to
  // a derived boolean (code-review fix, gate round 1), not the whole Set, so a create for one
  // repository does not re-render every OTHER repository's group too.
  const creating = useSessionsStore((state) => state.creatingRepositoryIds.has(repository.id))
  const renameRepository = useRepositoriesStore((state) => state.rename)
  const [removeOpen, setRemoveOpen] = useState(false)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  // Issue #887: the Project colour popover, opened from the actions menu's Colour item.
  const setRepositoryColor = useRepositoriesStore((state) => state.setColor)
  const [colorOpen, setColorOpen] = useState(false)
  const sidebarRgb = useSidebarRgb()
  // The popover's draft colour while it is open, so Cancel visibly reverts the header.
  const [previewColor, setPreviewColor] = useState<ProjectColor | null | undefined>(undefined)
  const projectColor = projectColorCss(previewColor === undefined ? repository.color : (previewColor ?? undefined), sidebarRgb)?.css
  const headerRowRef = useRef<HTMLDivElement>(null)
  // Issue #480: inline rename, the same F2 / Enter / Esc / blur-commit pattern as the Session
  // row's own rename (`SessionRow.tsx`) -- the model the issue names to copy.
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(repository.name)
  // Quality-gate fix (a11y, Medium, 2026-10-08): a failed rename keeps the field open (never
  // `setRenaming(false)` before the IPC call resolves) and shows this inline, tied to the input
  // via `aria-describedby`, instead of only a toast that drops the user's typed draft.
  const [renameError, setRenameError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef(false)
  const renameRequestedRef = useRef(false)
  const colourRequestedRef = useRef(false)
  // Issue #503: Report an issue, opened from the menu item once the menu has closed (the Colour pattern).
  const reportRequestedRef = useRef(false)
  const [reportOpen, setReportOpen] = useState(false)
  const renameErrorId = `repository-rename-error-${repository.id}`
  const groupRootRef = useRef<HTMLDivElement>(null)
  // Issue #559 gate round 3 (the #900 pattern, finding 1): a rename that makes this whole group
  // stop matching an active search query (a Project-name query is the only way a group, not
  // just one row, can be its OWN sole match) unmounts it on a later render, same as a Session
  // row's own rename -- shared with `useSessionRowActions.ts` so both get the identical fix.
  useFocusSearchOnStrandedUnmount(groupRootRef)

  async function handleQuickCreate(): Promise<void> {
    // Gate-fixes a code/a11y Medium (round 1): on `main` this returned early, silently, on a
    // second click of this still-`aria-disabled`-but-clickable button. Removing that guard left
    // a second click (or the #102 double-click itself) reach `create()`, which now refuses it
    // and shows an error toast for what used to be an inert no-op.
    if (useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) return
    const result = await createSession(repository.id, repository.defaultBranch)
    if (!result.ok) notify(result.error)
  }

  function startRenaming(): void {
    setDraftName(repository.name)
    setRenameError(null)
    setRenaming(true)
  }

  // Quality-gate fix (a11y, Medium, 2026-10-08): stays open on failure -- `setRenaming(false)`
  // only runs on an unchanged name or a successful rename, never before the IPC call settles --
  // so a rejected name (too long, a control character) keeps the field mounted with the user's
  // own typed text still in it and the error shown next to it, instead of a toast and a lost
  // draft.
  async function commitRename(): Promise<void> {
    const name = draftName.trim()
    if (name === repository.name) {
      setRenameError(null)
      setRenaming(false)
      return
    }
    // Quality-gate fix (cycle 2, 2026-10-08): validates client-side first, with the exact same
    // shared, code-point-aware rule the server enforces -- shows an over-long or disallowed
    // name's error immediately, with no round trip, and is the ONLY length cap now that the
    // input's own `maxLength` (UTF-16-unit-counted, wrongly capped emoji at 30 instead of 60) is
    // gone.
    const clientError = validateRepositoryName(name)
    if (clientError) {
      // Quality-gate fix (cycle 3, 2026-10-08): the field stays mounted on an error (this
      // function's own doc comment above), so the restore-focus effect (keyed on `renaming`)
      // never fires here to clear this itself -- left set, a LATER successful blur-commit (the
      // user clicks elsewhere, `onBlur` re-commits with the same now-valid text) would still
      // yank focus back to the trigger, overriding wherever the user's click had just taken it.
      restoreFocusRef.current = false
      setRenameError(clientError)
      return
    }
    const error = await renameRepository(repository.id, name)
    if (error) {
      // Quality-gate fix (cycle 3, 2026-10-08): same reasoning as the client-validation branch
      // above -- a server-side rejection (for example a race with another rename) must not leave
      // this armed for a later unrelated success to consume.
      restoreFocusRef.current = false
      setRenameError(error)
      return
    }
    setRenameError(null)
    setRenaming(false)
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation()
    if (event.key === 'Enter') {
      restoreFocusRef.current = true
      void commitRename()
    }
    if (event.key === 'Escape') {
      restoreFocusRef.current = true
      setRenameError(null)
      setDraftName(repository.name)
      setRenaming(false)
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'F2') {
      event.preventDefault()
      startRenaming()
    }
  }

  useEffect(() => {
    if (!renaming) return
    const raf = requestAnimationFrame(() => renameInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [renaming])

  useEffect(() => {
    if (renaming) return
    if (!restoreFocusRef.current) return
    restoreFocusRef.current = false
    triggerRef.current?.focus()
  }, [renaming])

  // Issue #528: a confirmed `none` is the only case that earns the plain "local only" icon, so an
  // unreadable repository or a parse failure is never shown as local-only when it might not be.
  // Issue #646: a known host adds its brand mark and the tooltip names owner/repo.
  const remoteIcon = remoteHeaderIcon(repository.remote)
  const remoteTooltip = remoteHeaderTooltip(repository.remote)
  return (
    <div ref={groupRootRef} className="flex flex-col" data-repository-id={repository.id}>
      <Collapsible open={isOpen} onOpenChange={(open) => useSessionListStore.getState().setRepositoryOpen(repository.id, open)}>
        <div ref={headerRowRef} className="group flex items-center gap-1 px-1">
          {renaming ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                ref={renameInputRef}
                autoFocus
                value={draftName}
                onChange={(event) => {
                  setDraftName(event.target.value)
                  setRenameError(null)
                }}
                onBlur={() => void commitRename()}
                onKeyDown={handleNameKeyDown}
                aria-label="Repository name"
                aria-invalid={renameError ? true : undefined}
                aria-describedby={renameError ? renameErrorId : undefined}
                className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              {renameError && (
                <p id={renameErrorId} role="alert" className="px-1 text-xs text-destructive">
                  {renameError}
                </p>
              )}
            </div>
          ) : (
            <GroupHeaderTrigger
              triggerRef={triggerRef}
              label={repository.name}
              title={repository.path}
              icon={remoteIcon}
              tooltip={remoteTooltip}
              onDoubleClick={startRenaming}
              onKeyDown={handleTriggerKeyDown}
              marker={marker}
              containsOpenSession={containsOpenSession}
              color={projectColor}
            />
          )}
          {/* These three action buttons' total width feeds BOTH `GROUP_HEADER_ACTIONS_OFFSET_PX`
              (this header's own tooltip `sideOffset`) AND `GROUP_HEADER_ACTIONS_WIDTH_PX`
              (`ArchivedGroup.tsx`'s matching spacer) in `GroupHeader.tsx` -- changing their size
              or count must update BOTH constants, or the #908 marker-column drift returns.
              #567 decision 6: ghost `icon-xs` (24px, 12px icons), hidden at rest and revealed by
              opacity -- never losing their place in the Tab order -- on hover anywhere in the
              header (`group-hover`), focus anywhere in it (`group-focus-within`), this control's
              own `aria-expanded` (the branch picker and the "..." menu), while a create is in
              flight, whenever the group has no active Sessions to hover over in the first place,
              and always under a `(hover: none)` pointer (a touch screen has no hover to reveal
              them). Ctrl+N's own focus-visible handles the "focus reveals the plus" rule below. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`New session from ${repository.defaultBranch} in ${repository.name}`}
                aria-disabled={creating || undefined}
                className={cn(HEADER_ACTION_BUTTON_CLASS, (creating || active.length === 0) && 'opacity-100', 'aria-disabled:[&_svg]:opacity-50')}
                // Quality-gate fix (round 2, Sec/Code/Verif Medium): no `aria-keyshortcuts`
                // here -- unlike `ChatHeader.tsx`'s Ctrl+W button or `MessageInput.tsx`'s
                // Ctrl+Shift+X button (each the ONE control its own chord always activates),
                // Ctrl+N activates the FOCUSED pane's repository's button, or only focuses the
                // first one -- every OTHER repository's button would advertise a chord that
                // does not reach it, a false shortcut claim to assistive tech. The tooltip's own
                // Kbd hint below stays (decision 7 asks for the hint there, not this attribute).
                // Issue #6, first slice: Ctrl+N's own fallback target (no pane open, 2+
                // repositories, or a focused pane's repository that can no longer be resolved)
                // moves focus here via `document.querySelector('[data-quick-create-session]')`
                // (`App.tsx`), which returns the FIRST match in DOM order -- i.e. this
                // repository group's own button when it is the first one rendered, with no
                // extra per-repository targeting needed.
                data-quick-create-session
                onClick={() => void handleQuickCreate()}
              >
                {creating ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <PlusIcon aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              New session from {repository.defaultBranch}
              {/* Issue #6, first slice, decision 7: the Ctrl+N hint goes on THIS tooltip only
                  -- not the row menu's "New session from {branch}" item, and not the branch-
                  picker button below, which is a different action (#620's own decision). */}
              <KbdGroup>
                <Kbd>Ctrl</Kbd>
                <Kbd>N</Kbd>
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <NewSessionDialog
              repository={repository}
              trigger={
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`New session from a branch in ${repository.name}`}
                    className={cn(HEADER_ACTION_BUTTON_CLASS, (creating || active.length === 0) && 'opacity-100')}
                  >
                    <GitBranchPlusIcon aria-hidden />
                  </Button>
                </TooltipTrigger>
              }
            />
            <TooltipContent>New session from a branch…</TooltipContent>
          </Tooltip>
          <ProjectColorPopover
            repository={repository}
            open={colorOpen}
            onOpenChange={setColorOpen}
            onApply={(color) => setRepositoryColor(repository.id, color)}
            returnFocusRef={menuTriggerRef}
            anchorRef={headerRowRef}
            onPreviewChange={setPreviewColor}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuTriggerRef}
                variant="ghost"
                size="icon-xs"
                aria-label={`Repository actions for ${repository.name}`}
                className={cn(HEADER_ACTION_BUTTON_CLASS, (creating || active.length === 0) && 'opacity-100')}
              >
                <EllipsisVerticalIcon aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              onCloseAutoFocus={(event) => {
                if (!renameRequestedRef.current && !colourRequestedRef.current && !reportRequestedRef.current) return
                const openColour = colourRequestedRef.current
                const openReport = reportRequestedRef.current
                renameRequestedRef.current = false
                colourRequestedRef.current = false
                reportRequestedRef.current = false
                event.preventDefault()
                // Open only once the menu has fully closed, so it cannot take focus back from the popover.
                if (openColour) setColorOpen(true)
                if (openReport) setReportOpen(true)
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  renameRequestedRef.current = true
                  startRenaming()
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  colourRequestedRef.current = true
                }}
              >
                Colour…
              </DropdownMenuItem>
              {githubRemoteSlug(repository.remote) && (
                <DropdownMenuItem
                  onSelect={() => {
                    reportRequestedRef.current = true
                  }}
                >
                  Report an issue…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setRemoveOpen(true)}>
                Remove repository…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent>
          {active.length === 0 ? (
            // Gate round 1 fix (High, three independent reviewers; decision 24): an open Project
            // with no Sessions used to render nothing at all under its header. One indented,
            // muted line, no action of its own -- the header's own "+" stays visible via the
            // `active.length === 0` override on `HEADER_ACTION_BUTTON_CLASS` above.
            // Gate round 2 fix (Low, architect L-e): decision 24's own exact text, "No sessions
            // yet", describes a Project that has never had one at all (`sessions.length === 0`);
            // a Project whose only Sessions are archived still HAS Sessions, so "yet" there was
            // inaccurate -- "No active sessions" instead, recorded on #567.
            <p className="py-1 pl-6 text-xs text-muted-foreground">
              {sessions.length === 0 ? 'No sessions yet' : 'No active sessions'}
            </p>
          ) : (
            <ul aria-label={`${repository.name} sessions`} className="flex flex-col gap-0 py-1">
              {active.map((session) => (
                <SessionRow key={session.id} session={session} repository={repository} />
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
      <ReportIssueDialog
        repository={repository}
        open={reportOpen}
        onOpenChange={setReportOpen}
        onCloseFocus={() => menuTriggerRef.current?.focus()}
      />
      <RemoveRepositoryDialog
        repository={repository}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onRemoved={focusRepositoryGroupOrReadiness}
        onCancelled={() => {
          if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
          else focusSessionsNav()
        }}
      />
    </div>
  )
}
