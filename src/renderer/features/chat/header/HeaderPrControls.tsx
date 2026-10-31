import { useEffect, useRef } from 'react'
import { EMPTY_READOUT_ENTRY, usePinnedPanelsStore, useReadoutStore, useSessionsStore } from '@/state'
import { LinkedIssueControls } from './LinkedIssueControls'
import { PullRequestControls } from './PullRequestControls'
import type { LinkedIssue } from '../../../../shared/model'

/** Chat header PR and linked-issue controls; the Session's origin issue leads the linked issues (#1310, #1315). */
export function HeaderPrControls({ sessionId }: { sessionId: string }) {
  const repositoryId = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.repositoryId)
  const originIssue = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.originIssue)
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
  if (!repositoryId) return null
  const prIssues = pullRequest?.linkedIssues ?? []
  const linkedIssues: LinkedIssue[] = originIssue
    ? [prIssues.find((issue) => issue.number === originIssue.number) ?? { number: originIssue.number, state: 'open', title: originIssue.title }, ...prIssues.filter((issue) => issue.number !== originIssue.number)]
    : prIssues
  if (!pullRequest && linkedIssues.length === 0) return null
  const liveState = pullRequest && live && live.repositoryId === repositoryId && live.number === pullRequest.number ? live.state : null

  return (
    <>
      {pullRequest && <PullRequestControls repositoryId={repositoryId} pullRequest={pullRequest} liveState={liveState} />}
      <LinkedIssueControls repositoryId={repositoryId} issues={linkedIssues} />
    </>
  )
}
