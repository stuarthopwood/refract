// Spec 018 slice 1 (issue #464), User Story 1: the Git changes panel's own assembly -- a
// scrollable region that swaps between the four grouped file lists and a selected file's diff.
// No independent Session binding of its own (FR-022): it always reflects whichever Session
// `sessionId` names, the same pattern `FileExplorerPanel.tsx`/`SideChatPanel.tsx` already use --
// a second Split pane renders its own `GitChangesPanel` instance with its own `sessionId` prop,
// so two panes never share state. The branch/ahead-behind header (User Story 3) and the
// commit-box footer (User Story 2) mount here in their own later commits.
//
// Diff placement (worker brief correction, supersedes tasks.md T015/spec.md's "opens in the
// main-area tab" wording only -- every other ruling in that consult stands): no cross-cutting
// main-area file-tab mechanism exists yet anywhere in `src/renderer` (that is issue #732's own,
// separate scope). Selecting a file swaps this panel's OWN scrollable content area from the
// groups list to that file's diff (`DiffViewFromPatch`, unchanged), with a "Back to changes"
// button. Known, flagged UX compromise for Stuart/Main: `DiffView`/`DiffViewFromPatch` were
// designed for full chat-pane width; here they render inside the 240-520px hosted pane instead,
// with their own existing horizontal scroll.
import { useEffect, useState } from 'react'
import { ArrowLeftIcon, CheckCircle2Icon, FileWarningIcon, FolderIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useGitChangesStore } from '@/state'
import { DiffViewFromPatch } from '@/features/chat/DiffView'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'
import { GitChangesGroup } from './GitChangesGroup'

// FR-002's own order: Conflicts/Staged/Changes/Untracked.
const GROUP_ORDER: readonly GitChangesGroupKind[] = ['conflicts', 'staged', 'changes', 'untracked']

interface DiffSelection {
  entry: GitChangesFileEntry
  group: GitChangesGroupKind
}

export function GitChangesPanel({ sessionId }: { sessionId: string | null }) {
  useEffect(() => {
    if (sessionId) void useGitChangesStore.getState().load(sessionId)
  }, [sessionId])

  const sessionEntry = useGitChangesStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const [selected, setSelected] = useState<DiffSelection | null>(null)

  // A different Session's own selection never bleeds into this one.
  useEffect(() => {
    setSelected(null)
  }, [sessionId])

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
    <div className="flex h-full flex-col overflow-hidden">
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
            // a genuine fetch error -- `sessionEntry.error`, when set, is this same text; this is
            // deliberately NOT a second `role="alert"` (GitCommitBox below is the one place this
            // panel raises that alert, so neither surface double-announces it).
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileWarningIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>Not available</EmptyTitle>
                <EmptyDescription>{sessionEntry?.error ?? "This worktree's Git status could not be read."}</EmptyDescription>
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
                onOpenDiff={(entry, group) => setSelected({ entry, group })}
              />
            ))}
          </div>
        )}
      </div>
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
  }, [sessionId, entry.path, staged])

  return (
    <div className="flex flex-col gap-1.5 p-1">
      <Button variant="outline" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeftIcon aria-hidden className="size-3.5" />
        Back to changes
      </Button>
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
