import {
  useAdvisorStore,
  useQueueStore,
  usePendingRequestsStore,
  useReadoutStore,
  useTranscriptStore
} from '@/state'
import type { SessionSnapshot } from '../../../shared/ipc'

function applySnapshotParts(sessionId: string, snapshot: SessionSnapshot, options: { transcript: boolean }): void {
  if (options.transcript) {
    useTranscriptStore.getState().reset(sessionId, snapshot.runtime.transcript)
  }
  useQueueStore.getState().apply(sessionId, snapshot.runtime.queue.followUp, snapshot.runtime.queue.steering)
  usePendingRequestsStore.getState().setForSession(sessionId, snapshot.runtime.pending)
  useReadoutStore.getState().reset(sessionId, snapshot.readout, snapshot.subagents)
  useAdvisorStore.getState().reset(sessionId, snapshot.advisorOn)
  // The panel is global (one group per Session), so a pane mounting for another Session leaves it alone; pruned agents drop via `dropPrunedSelection`.
}

/** Fans a `SessionSnapshot` out to the transcript, queue and pending-request stores. */
export function applySnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  applySnapshotParts(sessionId, snapshot, { transcript: true })
}

/** Like `applySnapshot` but skips the transcript, which live patches may already have updated. */
export function applySnapshotExceptTranscript(sessionId: string, snapshot: SessionSnapshot): void {
  applySnapshotParts(sessionId, snapshot, { transcript: false })
}
