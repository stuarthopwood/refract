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
//
// Gate round 2 fixes (2026-10-20):
// - Item 2: `GitChangesDiffPane` no longer tears an open diff down on every live snapshot
//   refresh -- only a genuinely new diff (a different path or staged side) shows `'loading'`;
//   a refresh of the SAME file keeps the current patch mounted (scroll/focus survive) and swaps
//   silently, only if the new text actually differs.
// - Item 3: the diff-restore effect now uses the group-scoped `focusGitRowInGroup` (via
//   `lastSelectionRef.current.group`), so Back/Escape from a partially staged file's Changes-
//   half diff lands on that SAME half's row, not whichever same-path row comes first in DOM
//   order.
// - Item 5: a `loadError` surfacing while a snapshot still shows (a background refresh failed,
//   but stale-but-known data remains) is now a quiet, always-mounted `role="status"` line in the
//   header area -- distinct from the Not-available state's own text below, which is now
//   `role="alert"` (there is nothing else on screen there, so it IS the primary signal, unlike
//   the quieter case where real groups/commit box are still visible underneath it).
// - Item 6: the commit box now stays mounted once a snapshot has EVER loaded for this Session,
//   even if a later load reverts it to `null` (`GitCommitBox.tsx`'s own `!entry?.snapshot` reason
//   covers that state truthfully instead of the box vanishing outright).
// - Item 7: a worktree lifecycle operation (archive/delete/recreateWorktree) stops this
//   Session's own watcher for its whole duration (gate round 1 item 1) and fires
//   `file-explorer:reset` for this Session once it concludes, success or failure
//   (`WorktreeOperationGuard`'s own emission) -- re-calling `ensureWatching` on that event,
//   independent of the mount-refcount bookkeeping below, is what actually restarts a real
//   watcher once the operation's own busy guard clears.
// - Item 14 (FR-016): once the LAST mount of this Session's panel unmounts (refcount reaches
//   zero, i.e. nothing else is watching it either), its entire store entry is forgotten too --
//   not just the watcher stopped -- so a fully closed panel holds no stale state in memory.
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
import { focusGitRow, focusGitRowInGroup, focusNearestGroupTrigger, GROUP_ORDER } from './focus'

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
        // Item 14 (gate round 2, FR-016): nothing else watches this Session's panel anymore --
        // drop its whole store entry, not just the watcher.
        useGitChangesStore.getState().forgetSession(id)
      } else {
        watcherRefCounts.set(id, remaining)
      }
    }
  }, [sessionId])

  // Item 7 (gate round 2): independent of the refcount bookkeeping above (which only guards the
  // FIRST mount against React StrictMode's dev-time double-invoke, not "has this ever been
  // called") -- a worktree lifecycle operation can stop this Session's own watcher out from
  // under an already-mounted panel; `file-explorer:reset` is the signal it has concluded
  // (success or failure), and the real fix is just trying `ensureWatching` again then. The IPC
  // call itself never reports back whether a watcher genuinely started or was refused while
  // busy (it is fire-and-forget on the Rust side) -- this retry-on-reset is the actual safety
  // net, not a renderer-side "isWatching" flag this file deliberately does not invent.
  useEffect(() => {
    if (!sessionId) return
    const id = sessionId
    return window.refract.onFileExplorerReset(({ sessionId: resetSessionId }) => {
      if (resetSessionId !== id) return
      window.refract.gitChanges
        .ensureWatching(id)
        .then((result) => {
          if (!result.ok) console.warn('GitChangesPanel: ensureWatching (post-reset) failed', result.error)
        })
        .catch((err) => console.warn('GitChangesPanel: ensureWatching (post-reset) rejected', err))
    })
  }, [sessionId])

  useEffect(() => {
    if (sessionId) void useGitChangesStore.getState().load(sessionId)
  }, [sessionId])

  const sessionEntry = useGitChangesStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const [selected, setSelected] = useState<DiffSelection | null>(null)
  const [groupOpen, setGroupOpen] = useState<Record<GitChangesGroupKind, boolean>>(DEFAULT_GROUP_OPEN)
  // Item 6 (gate round 2): once a snapshot has EVER loaded for this Session, the commit box
  // stays mounted even if a later load reverts it to `null` -- reset alongside everything else
  // below the moment `sessionId` itself changes.
  const [hasEverLoadedSnapshot, setHasEverLoadedSnapshot] = useState(false)
  // Gate round 3 fix (#1076 HIGH 2): true once the FIRST load for this Session has settled
  // (regardless of outcome) -- "Loading…" below only ever shows before this flips, so a LATER
  // background refresh (watcher ping, post-action refetch, status transition) that also ends
  // with `snapshot: null` never swaps the Not-available `Empty`/`role="alert"` node back out for
  // "Loading…" and in again, which re-mounted (and so re-announced) that `role="alert"` on every
  // single such refresh even when the error text never actually changed.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  // Item 7 (gate round 1): which row opened the currently (or most recently) selected diff --
  // read when `selected` transitions back to `null` (Back, or Escape inside the diff pane) so
  // focus can return to that same row, wherever it ended up.
  const lastSelectionRef = useRef<DiffSelection | null>(null)

  // A different Session's own selection never bleeds into this one.
  useEffect(() => {
    setSelected(null)
    lastSelectionRef.current = null
    setGroupOpen(DEFAULT_GROUP_OPEN)
    setHasEverLoadedSnapshot(false)
    setHasLoadedOnce(false)
  }, [sessionId])

  useEffect(() => {
    if (selected !== null || !sessionId || !lastSelectionRef.current) return
    const { entry, group } = lastSelectionRef.current
    // Item 3 (gate round 2): group-scoped -- a partially staged file's Staged/Changes halves
    // share the same `data-git-row-path`; landing back in the SAME half this diff was opened
    // from is the whole point, never whichever half happens to come first in DOM order.
    if (!focusGitRowInGroup(sessionId, group, entry.path) && !focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
    lastSelectionRef.current = null
  }, [selected, sessionId])

  const snapshot = sessionEntry?.snapshot ?? null

  useEffect(() => {
    if (snapshot) setHasEverLoadedSnapshot(true)
  }, [snapshot])

  useEffect(() => {
    if (sessionEntry && !sessionEntry.loading) setHasLoadedOnce(true)
  }, [sessionEntry])

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

  const loading = sessionEntry?.loading ?? true

  return (
    <div data-git-changes-session={sessionId} className="flex h-full flex-col overflow-hidden">
      {snapshot && <GitChangesHeader header={snapshot.header} />}
      {/* Item 5 (gate round 2): a background refresh failure while a stale-but-known snapshot
          still shows -- quiet and always mounted, distinct from GitCommitBox's own role="alert"
          for an ACTION failure, and from the Not-available state's own role="alert" below
          (which has nothing else to show at all, so it IS the primary signal there). */}
      {snapshot && sessionEntry?.loadError && (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {sessionEntry.loadError}
        </p>
      )}
      <div className="flex-1 overflow-auto">
        {selected ? (
          <GitChangesDiffPane sessionId={sessionId} selection={selected} onBack={() => setSelected(null)} />
        ) : !snapshot ? (
          loading && !hasLoadedOnce ? (
            <p role="status" className="p-2 text-sm text-muted-foreground">
              Loading…
            </p>
          ) : (
            // FR-018/SC-006: a legitimate not-available state (not a repo, a git failure, or past
            // the status size cap) collapses to the same `snapshot: null` the store also uses for
            // a genuine fetch error -- `sessionEntry.loadError`, when set, is this same text.
            // Gate round 2 item 5: this IS now a `role="alert"` -- there is nothing else on
            // screen in this state (unlike the quiet header-area line above, which only shows
            // while real groups/commit-box content is still visible underneath it).
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileWarningIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>Not available</EmptyTitle>
                <EmptyDescription role="alert">{sessionEntry?.loadError ?? "This worktree's Git status could not be read."}</EmptyDescription>
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
      {(snapshot || hasEverLoadedSnapshot) && <GitCommitBox sessionId={sessionId} />}
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
  const { entry: initialEntry, group } = selection
  const staged = group === 'staged'
  const [state, setState] = useState<DiffState>('loading')
  const backButtonRef = useRef<HTMLButtonElement>(null)
  // Item 2 (gate round 2): the live row for this exact path within its OWN group -- only the
  // fields that could actually change the diff TEXT (`mark`/`additions`/`deletions`/`partial`)
  // drive a refetch, folded into one primitive string `signature` so an unrelated snapshot
  // refresh (a DIFFERENT file changing) never re-triggers this effect at all. Falls back to the
  // original selection's own entry if this row is no longer in its original group (its OWN
  // additions/deletions badge then simply shows the last known values, a reasonable degrade).
  const liveEntry = useGitChangesStore((s) => s.bySession[sessionId]?.snapshot?.groups[group].find((candidate) => candidate.path === initialEntry.path) ?? null)
  const entry = liveEntry ?? initialEntry
  const signature = `${entry.mark}:${entry.additions}:${entry.deletions}:${entry.partial}`
  // Tracks the (path, staged) this effect last genuinely fetched FOR -- distinguishes "a
  // genuinely new diff was opened" (show `'loading'`, same as before) from "the SAME diff's own
  // live data just changed" (refetch silently in the background, never show `'loading'` again,
  // gate round 2 item 2's own "don't re-announce Loading diff…" requirement).
  const identityRef = useRef<{ path: string; staged: boolean } | null>(null)

  // Item 7 (gate round 1): focuses Back on open, the same way a dialog focuses its own first
  // control on mount.
  useEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const isNewDiff = identityRef.current?.path !== initialEntry.path || identityRef.current?.staged !== staged
    identityRef.current = { path: initialEntry.path, staged }
    if (isNewDiff) setState('loading')
    window.refract.gitChanges
      .diff(sessionId, initialEntry.path, staged)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setState({ error: result.error.message })
          return
        }
        // Keep the current patch mounted (scroll/focus survive) unless the text actually
        // differs -- a background refetch that resolves to byte-identical text is a no-op.
        setState((prev) => (typeof prev === 'object' && 'patch' in prev && prev.patch === result.value.patch ? prev : { patch: result.value.patch }))
      })
      .catch(() => {
        if (!cancelled) setState({ error: "Couldn't load this file's diff" })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, initialEntry.path, staged, signature])

  return (
    <div
      // Item 11 (gate round 2): focusable so a click on non-interactive diff text (which would
      // otherwise leave focus on `<body>`, where this div's own Escape handler below can never
      // receive the keydown) still keeps keyboard focus somewhere inside this subtree. Gate
      // round 3 fix (#1076 MEDIUM c, UI review): `min-h-full` -- a SHORT diff's own content was
      // shorter than the scrollable region around it, so a click in the empty space below it
      // landed on that outer scroll container instead of this div, leaving focus stranded where
      // Escape could never reach this div's own handler below.
      tabIndex={-1}
      className="flex min-h-full flex-col gap-1.5 p-1 outline-none"
      onKeyDown={(event) => {
        // Item 14 (gate round 1): Escape returns to the list, same as the explicit Back button.
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
