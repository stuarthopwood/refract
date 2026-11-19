import { useEffect, useRef, useState } from 'react'
import { InlineStatus } from '@/components/InlineStatus'
import { DiffViewFromPatch } from '@/features/chat/DiffView'
import { useGitChangesStore } from '@/state'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { documentTabId, useDocumentTabsStore } from '@/state/document-tabs-store'
import type { GitChangesGroupKind } from '../../../../shared/model'
import { diffGroupLabel } from './GitChangesGroup'
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

/** One file's diff in one group: fetches it, refreshes it as the file changes, and says so when the file stops being changed. */
export function GitDiffView({ sessionId, group, path }: { sessionId: string; group: GitChangesGroupKind; path: string }) {
  const [state, setState] = useState<DiffState>('loading')
  const shownRef = useRef<string | null>(null)
  const entry = useGitChangesStore((s) => findLiveEntry(s.bySession[sessionId]?.snapshot, group, path))
  const gone = useGitChangesStore((s) => isNoLongerChanged(s.bySession[sessionId]?.snapshot, group, path))
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

  useEffect(() => {
    useDocumentTabsStore.getState().markDead(sessionId, documentTabId({ kind: 'diff', group, path }), gone)
  }, [sessionId, group, path, gone])

  // The tab's own text is in the strip; the view's text has no live role, so the shared polite region is the one announcement.
  useEffect(() => {
    if (gone) useAgentAnnouncementStore.getState().announce(noLongerChangedAnnouncement(path))
  }, [gone, path])

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-1">
      <span className="shrink-0 px-1 text-xs text-muted-foreground">{diffGroupLabel(group)}</span>
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
  )
}
