// Issue #509 (PLAN.md row A2g): the Resume action shared by the session-list row button and the
// ChatPane stop banner's Resume button -- both must do the exact same three steps (recover, apply
// the resulting snapshot, send the default resume instruction as a real turn), so this is the one
// place that does it, rather than two call sites drifting apart.
import type { Result, SessionSnapshot } from '../../../shared/ipc';
import { DEFAULT_RESUME_INSTRUCTION } from '../../../shared/model';
import { applySnapshot } from './ChatPane';

export { canResumeSession } from './canResumeSession';

/** FR-034 (spec 001): a resume instruction is a real turn -- it can cost money and change files --
 * so it is only ever sent from an explicit click (this function), never automatically. Recovers
 * the agent first (restart plus reattach, the existing `sessions.recover`), applies the resulting
 * snapshot (safe even when no pane currently shows this Session -- `applySnapshot` only ever
 * writes to stores keyed by `sessionId`), then sends `DEFAULT_RESUME_INSTRUCTION` as a normal user
 * turn through `chat.send`, respecting the current Approval mode exactly like any other message.
 * A failed recover stops here and returns that failure -- the instruction is never sent into a
 * Session that is not actually back. */
export async function resumeSession(sessionId: string): Promise<Result<SessionSnapshot>> {
  const recoverResult = await window.refract.sessions.recover(sessionId);
  if (!recoverResult.ok) return recoverResult;
  applySnapshot(sessionId, recoverResult.value);
  const sendResult = await window.refract.chat.send(sessionId, DEFAULT_RESUME_INSTRUCTION);
  if (!sendResult.ok) return sendResult;
  return recoverResult;
}
