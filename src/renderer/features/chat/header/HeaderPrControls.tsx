import { useEffect, useRef } from 'react'
import { EMPTY_READOUT_ENTRY, usePinnedPanelsStore, useReadoutStore, useSessionsStore } from '@/state'
import { LinkedIssueControls } from './LinkedIssueControls'
import { PullRequestControls } from './PullRequestControls'

/** Chat header PR and linked-issue controls; renders nothing without a PR (#1315). */
export function HeaderPrControls({ sessionId }: { sessionId: string }) {
  const repositoryId = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.repositoryId)
  const pullRequest = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.pullRequest ?? null)
  const live = usePinnedPanelsStore((s) => s.livePullRequest)
  const readoutKey = pullRequest ? `${sessionId}:${pullRequest.number}` : null
  const readoutState = pullRequest?.state
  const last = useRef({ key: readoutKey, state: readoutState })
  useEffect(() => {
    // A newer readout state for the same session and PR means the pinned panel's snapshot is stale.
    if (last.current.key === readoutKey && last.current.state !== readoutState) usePinnedPanelsStore.getState().clearLivePullRequest()
    last.current = { key: readoutKey, state: readoutState }
  }, [readoutKey, readoutState])
  if (!repositoryId || !pullRequest) return null
  const liveState = live && live.repositoryId === repositoryId && live.number === pullRequest.number ? live.state : null

  return (
    <>
      <PullRequestControls repositoryId={repositoryId} pullRequest={pullRequest} liveState={liveState} />
      <LinkedIssueControls repositoryId={repositoryId} issues={pullRequest.linkedIssues} />
    </>
  )
}
