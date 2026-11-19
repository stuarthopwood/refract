import { useEffect, useState } from 'react'
import { CheckCircle2Icon, FileWarningIcon, FolderIcon } from 'lucide-react'
import { InlineStatus } from '@/components/InlineStatus'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { DEFAULT_GROUP_OPEN, useGitChangesStore } from '@/state'
import { openDocument } from '@/features/documents/open-document'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'
import { GitChangesGroup } from './GitChangesGroup'
import { GitChangesHeader } from './GitChangesHeader'
import { GitCommitBox } from './GitCommitBox'
import { GROUP_ORDER } from './focus'
import { useGitChangesWatch } from './useGitChangesWatch'

export function GitChangesPanel({ sessionId }: { sessionId: string | null }) {
  useGitChangesWatch(sessionId)

  useEffect(() => {
    if (sessionId) void useGitChangesStore.getState().load(sessionId)
  }, [sessionId])

  const sessionEntry = useGitChangesStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const groupOpen = useGitChangesStore((s) => (sessionId ? s.groupOpenBySession[sessionId] : undefined)) ?? DEFAULT_GROUP_OPEN
  const [hasEverLoadedSnapshot, setHasEverLoadedSnapshot] = useState(false)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)

  useEffect(() => {
    setHasEverLoadedSnapshot(false)
    setHasLoadedOnce(false)
  }, [sessionId])

  const showFileRequest = useGitChangesStore((s) => (sessionId ? s.showFileRequestBySession[sessionId] : undefined))
  const requestSnapshot = sessionEntry?.snapshot ?? null
  useEffect(() => {
    if (!sessionId || !showFileRequest || !requestSnapshot) return
    const group = GROUP_ORDER.find((kind) => requestSnapshot.groups[kind].some((candidate) => candidate.path === showFileRequest))
    if (group) openDocument(sessionId, { kind: 'diff', group, path: showFileRequest }, { focus: false, announce: `Agent opened diff of ${showFileRequest.split('/').pop()}` })
    useGitChangesStore.getState().clearShowFileRequest(sessionId)
  }, [sessionId, showFileRequest, requestSnapshot])

  const snapshot = sessionEntry?.snapshot ?? null

  useEffect(() => {
    if (snapshot) setHasEverLoadedSnapshot(true)
  }, [snapshot])

  useEffect(() => {
    if (sessionEntry && !sessionEntry.loading) setHasLoadedOnce(true)
  }, [sessionEntry])

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

  const openDiff = (entry: GitChangesFileEntry, group: GitChangesGroupKind) => {
    openDocument(sessionId, { kind: 'diff', group, path: entry.path })
  }

  return (
    <div data-git-changes-session={sessionId} className="flex h-full flex-col overflow-hidden">
      {snapshot && <GitChangesHeader header={snapshot.header} />}
      {/* A background refresh failure over a stale-but-known snapshot: quiet, mounted only while it
          fails, and distinct from GitCommitBox's role="alert" for an action failure. */}
      {snapshot && sessionEntry?.loadError && (
        <InlineStatus tone="notice" density="compact">
          {sessionEntry.loadError}
        </InlineStatus>
      )}
      <div className="flex-1 overflow-auto">
        {!snapshot ? (
          loading && !hasLoadedOnce ? (
            <InlineStatus tone="loading">Loading…</InlineStatus>
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
                onOpenChange={(next) => sessionId && useGitChangesStore.getState().setGroupOpen(sessionId, kind, next)}
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
