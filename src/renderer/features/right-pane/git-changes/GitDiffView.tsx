import { useEffect, useRef, useState } from 'react'
import { DocumentHeader } from '@/components/DocumentHeader'
import { InlineStatus } from '@/components/InlineStatus'
import { DiffViewFromPatch } from '@/features/chat/DiffView'
import { useGitChangesStore } from '@/state'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { useScrollMemory } from '@/features/documents/useScrollMemory'
import type { GitChangesGroupKind } from '../../../../shared/model'
import { diffGroupLabel } from './GitChangesGroup'
import { DocumentPathActions, type PathActionCallbacks } from '../file-explorer/path-actions'
import {
  DIFF_LOAD_ERROR,
  NO_LONGER_CHANGED,
  entrySignature,
  findLiveEntry,
  isNoLongerChanged,
  nextDiffState,
  noLongerChangedAnnouncement,
  patchStats,
  type DiffState
} from './git-diff-state'
import { useGitChangesWatch } from './useGitChangesWatch'

interface GitDiffViewProps extends PathActionCallbacks {
  sessionId: string
  group: GitChangesGroupKind
  path: string
  /** The tab's remembered scroll position; the tab store keeps it, not this view. */
  scrollTop: number | undefined
  onScrollTopChange: (scrollTop: number) => void
}

/** One file's diff in one group: fetches it, refreshes it as the file changes, and says so when the file stops being changed. */
export function GitDiffView({ sessionId, group, path, scrollTop, onScrollTopChange, onOpenInVSCode, onReveal, onCopyPath }: GitDiffViewProps) {
  const [state, setState] = useState<DiffState>('loading')
  const shownRef = useRef<string | null>(null)
  const entry = useGitChangesStore((s) => findLiveEntry(s.bySession[sessionId]?.snapshot, group, path))
  const gone = useGitChangesStore((s) => isNoLongerChanged(s.bySession[sessionId]?.snapshot, path))
  const scroll = useScrollMemory<HTMLDivElement>(gone || (typeof state === 'object' && 'patch' in state), scrollTop, onScrollTopChange)
  const signature = entrySignature(entry)

  // The panel is unmounted while a diff tab is active, so the view keeps the watcher and the snapshot alive itself.
  useGitChangesWatch(sessionId)
  useEffect(() => {
    void useGitChangesStore.getState().load(sessionId)
  }, [sessionId])

  useEffect(() => {
    if (gone) return
    let cancelled = false
    const shown = `${group}:${path}`
    if (shownRef.current !== shown) {
      shownRef.current = shown
      setState('loading')
    }
    window.refract.gitChanges
      .diff(sessionId, path, group === 'staged', group === 'untracked')
      .then((result) => {
        if (!cancelled) setState((prev) => nextDiffState(prev, result))
      })
      .catch(() => {
        if (!cancelled) setState({ error: DIFF_LOAD_ERROR })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, group, path, signature, gone])

  // The tab's own text is in the strip; the view's text has no live role, so the shared polite region is the one announcement.
  useEffect(() => {
    if (gone) useAgentAnnouncementStore.getState().announce(noLongerChangedAnnouncement(path))
  }, [gone, path])

  return (
    <div className="flex h-full flex-col">
      <DocumentHeader
        path={path}
        meta={diffGroupLabel(group)}
        actions={<DocumentPathActions path={path} onOpenInVSCode={onOpenInVSCode} onReveal={onReveal} onCopyPath={onCopyPath} />}
      />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {gone ? (
          <InlineStatus>{NO_LONGER_CHANGED}</InlineStatus>
        ) : state === 'loading' ? (
          <InlineStatus tone="loading">Loading diff…</InlineStatus>
        ) : 'error' in state ? (
          <InlineStatus tone="error">{state.error}</InlineStatus>
        ) : (
          <DiffViewFromPatch path={path} patch={state.patch} reason={state.reason} {...(entry ?? patchStats(state.patch))} />
        )}
      </div>
    </div>
  )
}
