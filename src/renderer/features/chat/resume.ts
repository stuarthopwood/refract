// Issue #509 (PLAN.md row A2g): the Resume action shared by the session-list row button and the
// ChatPane stop banner's Resume button. Quality-gate fix (2026-10-08): the actual recover-then-
// send sequence, and its per-session lock against a double send, now live entirely in main
// (`sessions.resume` IPC) -- this is just the renderer-side glue that applies the resulting
// snapshot to the stores, the one thing main cannot do.
import type { Result, SessionSnapshot } from '../../../shared/ipc';
import { applySnapshot, applySnapshotExceptTranscript } from './applySnapshot';

export { canResumeSession, stillEligibleAfterResume } from '../../../shared/canResumeSession';

/** FR-034 (spec 001): a resume instruction is a real turn -- it can cost money and change files
 * -- so it is only ever sent from an explicit click (this function), never automatically.
 * `sessions.resume` recovers the agent, re-checks eligibility server-side, and sends the default
 * instruction only once the agent is confirmed actually running again; this just applies the
 * returned snapshot (safe even when no pane currently shows this Session -- `applySnapshot` only
 * ever writes to stores keyed by `sessionId`). Quality-gate fix (cycle 2, 2026-10-08, updated
 * issue #603 cycle 7): a `stopped` snapshot means the restart itself failed and no instruction
 * was ever sent -- this snapshot IS the current state, applied in full. Otherwise the
 * instruction WAS sent as part of this same call, and this snapshot was built AFTER that send
 * resolved (not before, as earlier cycles had it) -- still applied without its transcript (see
 * `applySnapshotExceptTranscript`'s own doc comment for the race this still avoids, even post-
 * send). */
export async function resumeSession(sessionId: string): Promise<Result<SessionSnapshot>> {
  const result = await window.refract.sessions.resume(sessionId);
  if (result.ok) {
    if (result.value.runtime.status === 'stopped') applySnapshot(sessionId, result.value);
    else applySnapshotExceptTranscript(sessionId, result.value);
  }
  return result;
}
