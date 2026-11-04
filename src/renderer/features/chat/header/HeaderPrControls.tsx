import { useLayoutEffect, useRef } from 'react'
import { EMPTY_READOUT_ENTRY, usePinnedPanelsStore, useReadoutStore, useSessionsStore } from '@/state'
import { LinkedIssueControls } from './LinkedIssueControls'
import { PullRequestControls } from './PullRequestControls'
import { TouchedRefControls } from './TouchedRefControls'
import type { LinkedIssue, TouchedRef } from '../../../../shared/model'

const EMPTY_TOUCHED: TouchedRef[] = []

/** Chat header PR and linked-issue controls; the Session's origin issue leads the linked issues (#1310, #1315). */
export function HeaderPrControls({ sessionId }: { sessionId: string }) {
  const repositoryId = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.repositoryId)
  const originNumber = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.originIssue?.number)
  const originTitle = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.originIssue?.title)
  const pullRequest = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.pullRequest ?? null)
  const touched = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.touched ?? EMPTY_TOUCHED)
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
  const prIssues = pullRequest?.linkedIssues ?? []
  const linkedIssues: LinkedIssue[] =
    originNumber !== undefined
      ? [
          prIssues.find((issue) => issue.number === originNumber) ?? { number: originNumber, state: 'unknown', title: originTitle ?? '' },
          ...prIssues.filter((issue) => issue.number !== originNumber)
        ]
      : prIssues
  // Touched items already shown by the PR and linked-issue controls would repeat in the menu.
  const touchedItems = touched.filter(
    (item) =>
      !repositoryId ||
      item.repositoryId !== repositoryId ||
      (item.kind === 'pr' ? item.number !== pullRequest?.number : !linkedIssues.some((issue) => issue.number === item.number))
  )
  const hasLinked = Boolean(repositoryId) && (pullRequest !== null || linkedIssues.length > 0)
  if (!hasLinked && touchedItems.length === 0) return null

  return (
    <>
      {repositoryId && pullRequest && <PullRequestControls sessionId={sessionId} repositoryId={repositoryId} pullRequest={pullRequest} liveState={liveState} />}
      {repositoryId && <LinkedIssueControls sessionId={sessionId} repositoryId={repositoryId} issues={linkedIssues} />}
      <TouchedRefControls sessionId={sessionId} mode={hasLinked ? 'overflow' : 'badge'} items={touchedItems} />
    </>
  )
}
