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
        useGitChangesStore.getState().forgetSession(id)
      } else {
        watcherRefCounts.set(id, remaining)
      }
    }
  }, [sessionId])

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
  const [hasEverLoadedSnapshot, setHasEverLoadedSnapshot] = useState(false)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
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

type DiffState = 'loading' | { patch: string; reason?: string | null } | { error: string }

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
  const liveEntry = useGitChangesStore((s) => s.bySession[sessionId]?.snapshot?.groups[group].find((candidate) => candidate.path === initialEntry.path) ?? null)
  const entry = liveEntry ?? initialEntry
  const fileName = entry.path.slice(entry.folder ? entry.folder.length + 1 : 0)
  const signature = `${entry.mark}:${entry.additions}:${entry.deletions}:${entry.partial}`
  const identityRef = useRef<{ path: string; staged: boolean } | null>(null)

  useEffect(() => {
    backButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const isNewDiff = identityRef.current?.path !== initialEntry.path || identityRef.current?.staged !== staged
    identityRef.current = { path: initialEntry.path, staged }
    if (isNewDiff) setState('loading')
    window.refract.gitChanges
      .diff(sessionId, initialEntry.path, staged, group === 'untracked')
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setState({ error: result.error.message })
          return
        }
        setState((prev) =>
          typeof prev === 'object' && 'patch' in prev && prev.patch === result.value.patch && prev.reason === result.value.reason
            ? prev
            : { patch: result.value.patch, reason: result.value.reason }
        )
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
      tabIndex={-1}
      className="flex min-h-full flex-col gap-2 p-1 outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onBack()
        }
      }}
    >
      {/* Item 6 (#1101): `sticky top-0` keeps the Back button visible while the diff below it
          scrolls (the panel's own scroll region is the parent `overflow-auto` div in the main
          component above) -- a stop-gap until #732-dependent "Git diff opens in a main-area
          tab" ships and this whole diff pane (Back button included) is removed. `bg-background`
          (this hosted pane's own inherited base surface, set no closer than the app root) stops
          scrolled-past diff text from showing through underneath it. Gate round 1 LOW 5 (#1101):
          `py-1` gives the Back button's focus-visible ring clearance, so it does not clip
          against the sticky bar's own edge.
          #1111 item 4/Low "border-b": the arrow and the file name are now ONE ghost button
          (`title={entry.path}` is the Low item's own actionable hover text, the accessible name
          comes from the visible "Back to changes from <file>" label below) instead of a
          separate name span beside an icon-only control -- also fixes the Low "file name shown
          twice" item, since that separate span was the duplicate. `border-b border-divider`
          (Low item) separates the bar from the diff without heavy chrome. */}
      <div className="no-drag-region sticky top-0 z-10 flex items-center gap-2 border-b border-divider bg-background py-1">
        <Button
          ref={backButtonRef}
          variant="ghost"
          size="sm"
          title={entry.path}
          aria-label={`Back to changes from ${fileName}`}
          onClick={onBack}
          className="min-w-0 flex-1 justify-start gap-2 px-1 focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        >
          <ArrowLeftIcon aria-hidden className="size-4 shrink-0" />
          <span aria-hidden className="min-w-0 truncate">
            {fileName}
          </span>
        </Button>
        {/* Low item: an untracked file's own group is "Untracked", never "Unstaged" --
            `staged`/`unstaged` only describes the index/working-tree distinction a TRACKED file
            has; an untracked file has neither. */}
        <span className="shrink-0 text-xs text-muted-foreground">{group === 'untracked' ? 'Untracked' : staged ? 'Staged' : 'Unstaged'}</span>
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
        <DiffViewFromPatch path={entry.path} patch={state.patch} reason={state.reason} additions={entry.additions} deletions={entry.deletions} hideFileName />
      )}
    </div>
  )
}
