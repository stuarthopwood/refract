import { useLayoutEffect, useRef } from 'react'
import { EMPTY_READOUT_ENTRY, usePinnedPanelsStore, useReadoutStore, useSessionsStore } from '@/state'
import { LinkedIssueControls } from './LinkedIssueControls'
import { PullRequestControls } from './PullRequestControls'
import type { LinkedIssue } from '../../../../shared/model'

/** Chat header PR and linked-issue controls; the Session's origin issue leads the linked issues (#1310, #1315). */
export function HeaderPrControls({ sessionId }: { sessionId: string }) {
  const repositoryId = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.repositoryId)
  const originNumber = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.originIssue?.number)
  const originTitle = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.originIssue?.title)
  const pullRequest = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.pullRequest ?? null)
  const liveState = usePinnedPanelsStore((s) => {
    const live = s.livePullRequest
    return pullRequest && live && live.repositoryId === repositoryId && live.number === pullRequest.number ? live.state : null
  })
  const readoutKey = pullRequest ? `${sessionId}:${pullRequest.number}` : null
  const readoutState = pullRequest?.state
  const last = useRef({ key: readoutKey, state: readoutState })
  // A layout effect so a stale pinned-panel snapshot never paints for a frame after a newer readout.
  useLayoutEffect(() => {
    // A newer readout state for the same session and PR means the pinned panel's snapshot is stale.
    if (last.current.key === readoutKey && last.current.state !== readoutState) usePinnedPanelsStore.getState().clearLivePullRequest()
    last.current = { key: readoutKey, state: readoutState }
  }, [readoutKey, readoutState])
  if (!repositoryId) return null
  const prIssues = pullRequest?.linkedIssues ?? []
  const linkedIssues: LinkedIssue[] =
    originNumber !== undefined
      ? [
          prIssues.find((issue) => issue.number === originNumber) ?? { number: originNumber, state: 'unknown', title: originTitle ?? '' },
          ...prIssues.filter((issue) => issue.number !== originNumber)
        ]
      : prIssues
  if (!pullRequest && linkedIssues.length === 0) return null

  return (
    <>
      {pullRequest && <PullRequestControls sessionId={sessionId} repositoryId={repositoryId} pullRequest={pullRequest} liveState={liveState} />}
      <LinkedIssueControls sessionId={sessionId} repositoryId={repositoryId} issues={linkedIssues} />
    </>
  )
}
