// Spec 018 slice 1 (issue #464): the Git changes panel's own assembly -- the branch/ahead-behind
// header (User Story 3) above a scrollable region that swaps between the four grouped file
// lists (User Story 1) and a selected file's diff, with the fixed commit-box footer (User Story
// 2) always mounted beneath it. No independent Session binding of its own (FR-022): it always
// reflects whichever Session `sessionId` names, the same pattern `FileExplorerPanel.tsx`/
// `SideChatPanel.tsx` already use -- a second Split pane renders its own `GitChangesPanel`
// instance with its own `sessionId` prop, so two panes never share state.
//
// Diff placement (worker brief correction, supersedes tasks.md T015/spec.md's "opens in the
// main-area tab" wording only -- every other ruling in that consult stands): no cross-cutting
// main-area file-tab mechanism exists yet anywhere in `src/renderer` (that is issue #732's own,
// separate scope). Selecting a file swaps this panel's OWN scrollable content area from the
// groups list to that file's diff (`DiffViewFromPatch`, unchanged), with a "Back to changes"
// button. Known, flagged UX compromise for Stuart/Main: `DiffView`/`DiffViewFromPatch` were
// designed for full chat-pane width; here they render inside the 240-520px hosted pane instead,
// with their own existing horizontal scroll.
//
// Gate round 1 fixes (2026-10-20):
// - `data-git-changes-session={sessionId}` on the root element: every focus-restoration query in
//   `focus.ts` scopes to it, so a Split's other pane (or the same Session shown in both panes,
//   FR-022) is never queried by mistake.
// - Group collapse state is lifted here (`groupOpen`, keyed by kind) instead of each
//   `GitChangesGroup` owning its own local `useState` -- see that file's own comment.
// - Item 7: opening a diff remembers which row opened it (`lastSelectionRef`); returning from it
//   focuses that row again (or the nearest surviving group trigger, if the row is gone).
// - The commit box is only mounted once a snapshot exists (LOW item): it has nothing truthful to
//   show while the repo state itself is unknown (no repo, a read failure, or still loading).
import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, CheckCircle2Icon, FileWarningIcon, FolderIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useGitChangesStore } from '@/state'
import { DiffViewFromPatch } from '@/features/chat/DiffView'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'
import { GitChangesGroup } from './GitChangesGroup'
import { GitChangesHeader } from './GitChangesHeader'
import { GitCommitBox } from './GitCommitBox'
import { focusGitRow, focusNearestGroupTrigger, GROUP_ORDER } from './focus'

// Mirrors `FileExplorerPanel.tsx`'s own `watcherRefCounts` map exactly (PR #671 gate round 7's
// own reasoning: this effect's mount/unmount net out to zero across React StrictMode's dev-time
// double-invoke before the real, lasting mount's `ensureWatching` runs) -- a separate map, since
// `gitChanges.ensureWatching`/`stopWatching` is its own IPC pair, not `fileExplorer`'s.
const watcherRefCounts = new Map<string, number>()

interface DiffSelection {
  entry: GitChangesFileEntry
  group: GitChangesGroupKind
}

const DEFAULT_GROUP_OPEN: Record<GitChangesGroupKind, boolean> = {
  conflicts: true,
  staged: true,
  changes: true,
  untracked: true
}

export function GitChangesPanel({ sessionId }: { sessionId: string | null }) {
  // FR-015b/FR-016: watches this Session's worktree only while this panel is mounted for it.
  useEffect(() => {
    if (!sessionId) return
    const id = sessionId
    const count = (watcherRefCounts.get(id) ?? 0) + 1
    watcherRefCounts.set(id, count)
    if (count === 1) {
      window.refract.gitChanges
        .ensureWatching(id)
        .then((result) => {
          if (!result.ok) console.warn('GitChangesPanel: ensureWatching failed', result.error)
        })
        .catch((err) => console.warn('GitChangesPanel: ensureWatching rejected', err))
    }
    return () => {
      const remaining = (watcherRefCounts.get(id) ?? 1) - 1
      if (remaining <= 0) {
        watcherRefCounts.delete(id)
        window.refract.gitChanges
          .stopWatching(id)
          .then((result) => {
            if (!result.ok) console.warn('GitChangesPanel: stopWatching failed', result.error)
          })
          .catch((err) => console.warn('GitChangesPanel: stopWatching rejected', err))
      } else {
        watcherRefCounts.set(id, remaining)
      }
    }
  }, [sessionId])

  useEffect(() => {
    if (sessionId) void useGitChangesStore.getState().load(sessionId)
  }, [sessionId])

  const sessionEntry = useGitChangesStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const [selected, setSelected] = useState<DiffSelection | null>(null)
  const [groupOpen, setGroupOpen] = useState<Record<GitChangesGroupKind, boolean>>(DEFAULT_GROUP_OPEN)
  // Item 7: which row opened the currently (or most recently) selected diff -- read when
  // `selected` transitions back to `null` (Back, or Escape inside the diff pane) so focus can
  // return to that same row, wherever it ended up.
  const lastSelectionRef = useRef<DiffSelection | null>(null)

  // A different Session's own selection never bleeds into this one.
  useEffect(() => {
    setSelected(null)
    lastSelectionRef.current = null
    setGroupOpen(DEFAULT_GROUP_OPEN)
  }, [sessionId])

  useEffect(() => {
    if (selected !== null || !sessionId || !lastSelectionRef.current) return
    const { entry, group } = lastSelectionRef.current
    if (!focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
    lastSelectionRef.current = null
  }, [selected, sessionId])

  function openDiff(entry: GitChangesFileEntry, group: GitChangesGroupKind): void {
    lastSelectionRef.current = { entry, group }
    setSelected({ entry, group })
  }

  if (!sessionId) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No Session open</EmptyTitle>
          <EmptyDescription>Open a Session to see its Git changes.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const snapshot = sessionEntry?.snapshot ?? null
  const loading = sessionEntry?.loading ?? true

  return (
    <div data-git-changes-session={sessionId} className="flex h-full flex-col overflow-hidden">
      {snapshot && <GitChangesHeader header={snapshot.header} />}
      <div className="flex-1 overflow-auto">
        {selected ? (
          <GitChangesDiffPane sessionId={sessionId} selection={selected} onBack={() => setSelected(null)} />
        ) : !snapshot ? (
          loading ? (
            <p role="status" className="p-2 text-sm text-muted-foreground">
              Loading…
            </p>
          ) : (
            // FR-018/SC-006: a legitimate not-available state (not a repo, a git failure, or past
            // the status size cap) collapses to the same `snapshot: null` the store also uses for
            // a genuine fetch error -- `sessionEntry.loadError`, when set, is this same text; this
            // is deliberately NOT a second `role="alert"` (GitCommitBox is the one place this
            // panel raises that alert, so neither surface double-announces it).
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileWarningIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>Not available</EmptyTitle>
                <EmptyDescription>{sessionEntry?.loadError ?? "This worktree's Git status could not be read."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : GROUP_ORDER.every((kind) => snapshot.groups[kind].length === 0) ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CheckCircle2Icon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No pending changes</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1 p-1">
            {GROUP_ORDER.filter((kind) => snapshot.groups[kind].length > 0).map((kind) => (
              <GitChangesGroup
                key={kind}
                kind={kind}
                entries={snapshot.groups[kind]}
                sessionId={sessionId}
                open={groupOpen[kind]}
                onOpenChange={(next) => setGroupOpen((prev) => ({ ...prev, [kind]: next }))}
                onOpenDiff={openDiff}
              />
            ))}
          </div>
        )}
      </div>
      {snapshot && <GitCommitBox sessionId={sessionId} />}
    </div>
  )
}

type DiffState = 'loading' | { patch: string } | { error: string }

function GitChangesDiffPane({
  sessionId,
  selection,
  onBack
}: {
  sessionId: string
  selection: DiffSelection
  onBack: () => void
}) {
  const { entry, group } = selection
  const staged = group === 'staged'
  const [state, setState] = useState<DiffState>('loading')
  const backButtonRef = useRef<HTMLButtonElement>(null)
  // Item 14 (gate round 1): re-fetches whenever this Session's own snapshot object changes
  // underneath an open diff (a watcher ping, a status transition, or this same file's own
  // stage/unstage/commit from elsewhere) -- previously this effect only re-ran if the SELECTED
  // file/side changed, so an open diff silently went stale through a live refresh.
  const snapshot = useGitChangesStore((s) => s.bySession[sessionId]?.snapshot)

  // Item 7: focuses Back on open, the same way a dialog focuses its own first control on mount.
  useEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    setState('loading')
    window.refract.gitChanges
      .diff(sessionId, entry.path, staged)
      .then((result) => {
        if (cancelled) return
        setState(result.ok ? result.value : { error: result.error.message })
      })
      .catch(() => {
        if (!cancelled) setState({ error: "Couldn't load this file's diff" })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, entry.path, staged, snapshot])

  return (
    <div
      className="flex flex-col gap-1.5 p-1"
      onKeyDown={(event) => {
        // Item 14: Escape returns to the list, same as the explicit Back button.
        if (event.key === 'Escape') {
          event.preventDefault()
          onBack()
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Button ref={backButtonRef} variant="outline" size="sm" className="self-start" onClick={onBack}>
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Back to changes
        </Button>
        <span className="text-xs text-muted-foreground">{staged ? 'Staged' : 'Unstaged'}</span>
      </div>
      {state === 'loading' ? (
        <p role="status" className="p-2 text-sm text-muted-foreground">
          Loading diff…
        </p>
      ) : 'error' in state ? (
        <p role="alert" className="p-2 text-sm text-destructive">
          {state.error}
        </p>
      ) : (
        <DiffViewFromPatch path={entry.path} patch={state.patch} additions={entry.additions} deletions={entry.deletions} />
      )}
    </div>
  )
}
