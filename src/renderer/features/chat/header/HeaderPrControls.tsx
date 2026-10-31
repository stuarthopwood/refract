import { useEffect, useRef } from 'react'
import { EMPTY_READOUT_ENTRY, usePinnedPanelsStore, useReadoutStore, useSessionsStore } from '@/state'
import { LinkedIssueControls } from './LinkedIssueControls'
import { PullRequestControls } from './PullRequestControls'

/** Chat header PR and linked-issue controls; renders nothing without a PR (#1315). */
export function HeaderPrControls({ sessionId }: { sessionId: string }) {
  const repositoryId = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.repositoryId)
  const pullRequest = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.pullRequest ?? null)
  const live = usePinnedPanelsStore((s) => s.livePullRequest)
  const readoutState = pullRequest?.state
  const lastReadoutState = useRef(readoutState)
  useEffect(() => {
    // A newer readout state means the pinned panel's snapshot is stale; let the readout win.
    if (lastReadoutState.current !== readoutState) usePinnedPanelsStore.getState().clearLivePullRequest()
    lastReadoutState.current = readoutState
  }, [readoutState])
  if (!repositoryId || !pullRequest) return null
  const liveState = live && live.repositoryId === repositoryId && live.number === pullRequest.number ? live.state : null

  return (
    <>
      <PullRequestControls repositoryId={repositoryId} pullRequest={pullRequest} liveState={liveState} />
      <LinkedIssueControls repositoryId={repositoryId} issues={pullRequest.linkedIssues} />
    </>
  )
}
