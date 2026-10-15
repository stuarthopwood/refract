import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { EllipsisVerticalIcon, FolderGit2Icon, FolderGitIcon, GitBranchPlusIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react'
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
import { RemoveRepositoryDialog } from '@/features/sessions/RemoveRepositoryDialog'
import { focusRepositoryGroupOrReadiness, focusSessionsNav } from '@/lib/focus'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { notify, useRepositoriesStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { validateRepositoryName } from '../../../shared/repositoryName'
import { GroupHeaderTrigger } from './GroupHeader'
import { SessionRow } from './SessionRow'

export function RepositoryGroup({
  repository,
  sessions
}: {
  repository: Repository
  sessions: SessionSummary[]
}) {
  const createSession = useSessionsStore((state) => state.create)
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
  // Issue #480: inline rename, the same F2 / Enter / Esc / blur-commit pattern as the Session
  // row's own rename (`SessionRow` above) -- the model the issue names to copy.
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
  const renameErrorId = `repository-rename-error-${repository.id}`

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

  // Issue #527: archived Sessions no longer get their own per-repository group here -- they all
  // move into one cross-repository `ArchivedGroup` at the bottom of the list instead.
  const active = sessions.filter((session) => !session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  // Issue #528: a confirmed `none` is the only case that earns the plain "local only" icon --
  // `has` and the honest `unknown` "could not tell" case both get the same remote-capable icon,
  // so an unreadable repository or a parse failure is never shown as local-only when it might
  // not be (the issue's own accessibility rule: never a false claim either way).
  const remoteIcon = repository.remote?.kind === 'none' ? FolderGitIcon : FolderGit2Icon
  // Gate round 2 fix (Low, code-reviewer + security-auditor): `git config`'s raw configured URL
  // (unlike round 1's `git remote get-url`) never applies a `url.<base>.insteadOf` rewrite, so a
  // shorthand remote (for example `gh:owner/repo`) reports its literal, undotted alias as the
  // "host" -- still correctly classed `has` (the icon is right), but naming a fake host in the
  // tooltip would be worse than naming none. Only a host containing a dot is shown by name.
  const remoteTooltip =
    repository.remote?.kind === 'has'
      ? repository.remote.host.includes('.')
        ? `Git repository, remote: ${repository.remote.host}`
        : 'Git repository, has a remote'
      : repository.remote?.kind === 'none'
        ? 'Git repository, local only (no remote)'
        : 'Git repository'
  return (
    <div className="flex flex-col" data-repository-id={repository.id}>
      <Collapsible defaultOpen>
        <div className="group flex items-center gap-1 px-1">
          {renaming ? (
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
                className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              {renameError && (
                <p id={renameErrorId} role="alert" className="px-1.5 text-xs text-destructive">
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
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`New session from ${repository.defaultBranch} in ${repository.name}`}
                aria-disabled={creating || undefined}
                className="aria-disabled:opacity-50"
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
                  <Button variant="ghost" size="icon-sm" aria-label={`New session from a branch in ${repository.name}`}>
                    <GitBranchPlusIcon aria-hidden />
                  </Button>
                </TooltipTrigger>
              }
            />
            <TooltipContent>New session from a branch…</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                ref={menuTriggerRef}
                type="button"
                aria-label={`Repository actions for ${repository.name}`}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-border hover:text-foreground focus:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
              >
                <EllipsisVerticalIcon aria-hidden className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              onCloseAutoFocus={(event) => {
                if (!renameRequestedRef.current) return
                renameRequestedRef.current = false
                event.preventDefault()
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
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setRemoveOpen(true)}>
                Remove repository…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent>
          <ul aria-label={`${repository.name} sessions`} className="flex flex-col gap-0.5 py-1">
            {active.map((session) => (
              <SessionRow key={session.id} session={session} repository={repository} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
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
