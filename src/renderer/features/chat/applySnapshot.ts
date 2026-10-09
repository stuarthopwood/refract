// Issue #509 quality-gate fix (2026-10-08): split out of ChatPane.tsx to break a circular import
// (resume.ts needed it, but ChatPane.tsx was importing resumeSession/canResumeSession FROM
// resume.ts -- a cycle). Shared by ChatPane, ConversationSwitcher, MessageInput's "not-started"
// open-then-send path, and resume.ts.
import {
  useQueueStore,
  usePendingRequestsStore,
  useReadoutStore,
  useSubagentPanelStore,
  useTranscriptStore
} from '@/state'
import type { SessionSnapshot } from '../../../shared/ipc'

function applySnapshotParts(sessionId: string, snapshot: SessionSnapshot, options: { transcript: boolean }): void {
  if (options.transcript) {
    useTranscriptStore.getState().reset(sessionId, snapshot.runtime.transcript)
  }
  useQueueStore.getState().apply(sessionId, snapshot.runtime.queue.followUp, snapshot.runtime.queue.steering)
  usePendingRequestsStore.getState().setForSession(sessionId, snapshot.runtime.pending)
  // Spec 004: the chip row's initial bundle, including the current turn's subagents as of this
  // snapshot (T024 live-finding fix: seeding `[]` here unconditionally wiped the Subagent panel's
  // list back to empty on every re-application of a snapshot -- a Settings round-trip or a
  // session switch away and back both remount ChatPane and so re-run this -- even though the
  // finished turn's subagents were still live in `SessionAgent.runtime.subagents` and its own
  // `readout.subagentCount` kept showing the real count the whole time); live updates still fold
  // on top via `subagents:update`.
  useReadoutStore.getState().reset(sessionId, snapshot.readout, snapshot.subagents)
  // Spec 004 FR-020: a Session switch leaves no stale subagent panel open for a different
  // Session's turn. Medium remediation (code-reviewer): only actually reset when this snapshot
  // is for a DIFFERENT Session than the panel was last open for -- a Settings round-trip (or any
  // other remount that re-applies a snapshot for the Session already visible, e.g. ChatPane
  // remounting on return from Settings) must never drop a panel the user deliberately opened for
  // a turn still in progress just because `sessions.open` ran again for the same Session.
  if (useSubagentPanelStore.getState().sessionId !== sessionId) {
    useSubagentPanelStore.getState().reset()
  }
}

/** Fans a `SessionSnapshot` (returned by `sessions.open`/`sessions.recover`/`conversations.*`,
 * contracts/ipc.md) out to the transcript, queue, and pending-request stores for that Session. */
export function applySnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  applySnapshotParts(sessionId, snapshot, { transcript: true })
}

/** Quality-gate fix (cycle 2, 2026-10-08; updated issue #603): `sessions.resume` (`resume.ts`)
 * now builds its returned snapshot AFTER sending the default resume instruction, not before
 * (or the pre-send one, if that post-send rebuild itself fails -- issue #603's own fallback) --
 * but by the time this IPC round trip resolves, that send's own live `transcript:patch` events
 * may ALREADY have streamed in and been applied to the transcript store in the gap between the
 * snapshot being captured and this call returning (the same "flash back to a stale transcript"
 * race `MessageInput.tsx`'s own not-started-send path already works around). `agent.start()`
 * already flushed one full transcript reset earlier in that same call, before the send, so
 * nothing here needs a second one -- only queue/pending/readout/subagents, never the transcript
 * a second time with now-stale content. */
export function applySnapshotExceptTranscript(sessionId: string, snapshot: SessionSnapshot): void {
  applySnapshotParts(sessionId, snapshot, { transcript: false })
}
