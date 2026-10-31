import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { EllipsisVerticalIcon, GitBranchPlusIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react'
import { InlineStatus } from '@/components/InlineStatus'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { RemoveRepositoryDialog } from '@/features/sessions/RemoveRepositoryDialog'
import { focusRepositoryGroupOrReadiness, focusSessionsNav } from '@/lib/focus'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { notify, useRepositoriesStore, useSessionListStore, useSessionsStore, useSplitStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { ProjectColor, Repository } from '../../../shared/model'
import { validateRepositoryName } from '../../../shared/repositoryName'
import { GroupHeaderRow, GroupHeaderTrigger, HEADER_ACTION_BUTTON_CLASS } from './GroupHeader'
import { githubRemoteSlug, remoteHeaderIcon, remoteHeaderTooltip } from './remoteDisplay'
import { ProjectColorPopover } from './ProjectColorPopover'
import { ReportIssueDialog } from './ReportIssueDialog'
import { useSidebarRgb } from './useSidebarRgb'
import { projectColorCss } from '@/lib/projectColor'
import { useFocusSearchOnStrandedUnmount } from './useFocusSearchOnStrandedUnmount'
import { groupWaitingState } from './sessionDisplay'
import { SessionRow } from './SessionRow'
import { ContextActionItems, DropdownActionItems } from './SessionRowParts'
import { buildRepositoryActions } from './repositoryActions'
import { IconButton } from '@/components/IconButton'

export function RepositoryGroup({
  repository,
  sessions
}: {
  repository: Repository
  sessions: SessionSummary[]
}) {
  const createSession = useSessionsStore((state) => state.create)
  // Archived Sessions live in `ArchivedGroup`; the marker and bar must read only this group's listed Sessions (#527).
  const active = sessions.filter((session) => !session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  // The marker and active bar are shown only while the group is closed (#735).
  const isOpen = useSessionListStore((state) => state.isGroupOpen(repository.id))
  const containsVisibleSession = useSplitStore((state) => active.some((session) => state.paneSessionIds.includes(session.id)))
  const marker = isOpen ? null : groupWaitingState(active)
  const containsOpenSession = !isOpen && containsVisibleSession
  // The in-flight guard lives in `sessions-store.ts`; a derived boolean avoids re-rendering other repositories' groups (#620).
  const creating = useSessionsStore((state) => state.creatingRepositoryIds.has(repository.id))
  const renameRepository = useRepositoriesStore((state) => state.rename)
  const [removeOpen, setRemoveOpen] = useState(false)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const setRepositoryColor = useRepositoriesStore((state) => state.setColor)
  const [colorOpen, setColorOpen] = useState(false)
  const sidebarRgb = useSidebarRgb()
  // The popover's draft colour while it is open, so Cancel visibly reverts the header.
  const [previewColor, setPreviewColor] = useState<ProjectColor | null | undefined>(undefined)
  const projectColor = projectColorCss(previewColor === undefined ? repository.color : (previewColor ?? undefined), sidebarRgb)?.css
  const headerRowRef = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(repository.name)
  // A failed rename keeps the field open and shows this inline via `aria-describedby`, so the typed draft is not lost.
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
  // A rename that stops this group matching the active search unmounts it; shared with `useSessionRowActions.ts` (#559).
  useFocusSearchOnStrandedUnmount(groupRootRef)

  async function handleQuickCreate(): Promise<void> {
    // A second click while a create is in flight is ignored.
    if (useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) return
    const result = await createSession(repository.id, repository.defaultBranch)
    if (!result.ok) notify(result.error)
  }

  function startRenaming(): void {
    setDraftName(repository.name)
    setRenameError(null)
    setRenaming(true)
  }

  // Stays open on failure so a rejected name keeps the typed text and shows the error beside it.
  async function commitRename(): Promise<void> {
    const name = draftName.trim()
    if (name === repository.name) {
      setRenameError(null)
      setRenaming(false)
      return
    }
    // Validate client-side with the server's code-point-aware rule; the input's UTF-16 `maxLength` wrongly capped emoji.
    const clientError = validateRepositoryName(name)
    if (clientError) {
      // The field stays mounted, so the restore-focus effect never clears this; left armed, a later blur-commit would yank focus back.
      restoreFocusRef.current = false
      setRenameError(clientError)
      return
    }
    const error = await renameRepository(repository.id, name)
    if (error) {
      // Disarm on server rejection too, as above.
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

  const actions = buildRepositoryActions(
    {
      onRename: () => {
        renameRequestedRef.current = true
        startRenaming()
      },
      onColour: () => {
        colourRequestedRef.current = true
      },
      onReport: () => {
        reportRequestedRef.current = true
      },
      onRemove: () => setRemoveOpen(true)
    },
    !!githubRemoteSlug(repository.remote)
  )

  function handleMenuCloseAutoFocus(event: Event): void {
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
  }

  // Only a confirmed `none` earns the "local only" icon; unreadable or unparsed repos must not (#528).
  const remoteIcon = remoteHeaderIcon(repository.remote)
  const remoteTooltip = remoteHeaderTooltip(repository.remote)
  return (
    <div ref={groupRootRef} className="flex flex-col" data-repository-id={repository.id}>
      <Collapsible open={isOpen} onOpenChange={(open) => useSessionListStore.getState().setRepositoryOpen(repository.id, open)}>
        <ContextMenu>
        <ContextMenuTrigger asChild disabled={renaming}>
        <GroupHeaderRow ref={headerRowRef} plain={renaming}>
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
                aria-label="Project name"
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
          {/* These buttons' total width feeds `GROUP_HEADER_ACTIONS_OFFSET_PX` and `GROUP_HEADER_ACTIONS_WIDTH_PX` (GroupHeader.tsx); change size or count in both or #908 marker drift returns. */}
          <IconButton
            size="icon-xs"
            label={`New session from ${repository.defaultBranch} in ${repository.name}`}
            shortcut={['Ctrl', 'N']}
            aria-disabled={creating || undefined}
            className={cn(HEADER_ACTION_BUTTON_CLASS, (creating || active.length === 0) && 'opacity-100', 'aria-disabled:[&_svg]:opacity-50')}
            // No `aria-keyshortcuts`: Ctrl+N reaches only one repository's button, so others would advertise a false chord.
            // Ctrl+N's fallback focuses the first `[data-quick-create-session]` in DOM order (App.tsx).
            data-quick-create-session
            onClick={() => void handleQuickCreate()}
          >
            {creating ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <PlusIcon aria-hidden />}
          </IconButton>
          <NewSessionDialog
            repository={repository}
            trigger={
              <IconButton
                size="icon-xs"
                label={`New session from a branch in ${repository.name}`}
                className={cn(HEADER_ACTION_BUTTON_CLASS, (creating || active.length === 0) && 'opacity-100')}
              >
                <GitBranchPlusIcon aria-hidden />
              </IconButton>
            }
          />
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
              <IconButton
                ref={menuTriggerRef}
                size="icon-xs"
                label={`Project actions for ${repository.name}`}
                className={cn(HEADER_ACTION_BUTTON_CLASS, (creating || active.length === 0) && 'opacity-100')}
              >
                <EllipsisVerticalIcon aria-hidden />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <DropdownActionItems actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </GroupHeaderRow>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
          <ContextActionItems actions={actions} />
        </ContextMenuContent>
        </ContextMenu>
        <CollapsibleContent>
          {active.length === 0 ? (
            // Empty-state line; "yet" is wrong when the only Sessions are archived (#567).
            <InlineStatus density="compact" className="pl-6">
              {sessions.length === 0 ? 'No sessions yet' : 'No active sessions'}
            </InlineStatus>
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
