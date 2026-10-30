import type { Result, SessionSnapshot } from '../../../shared/ipc';
import { applySnapshot, applySnapshotExceptTranscript } from './applySnapshot';

export { canResumeSession, stillEligibleAfterResume } from '../../../shared/canResumeSession';

/** Resumes a stopped session on explicit click only (the instruction is a real, costly turn) and applies main's snapshot. */
export async function resumeSession(sessionId: string): Promise<Result<SessionSnapshot>> {
  const result = await window.refract.sessions.resume(sessionId);
  if (result.ok) {
    if (result.value.runtime.status === 'stopped') applySnapshot(sessionId, result.value);
    else applySnapshotExceptTranscript(sessionId, result.value);
  }
  return result;
}
