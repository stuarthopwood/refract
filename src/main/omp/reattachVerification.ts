import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GetStateResponseData } from '../../shared/frames';
import type { Session } from '../../shared/model';

/** Issue #69 / FR-024: a missing current-Conversation file must be reported as exactly that --
 * naming the path -- not left to surface as the far more confusing "messageCount is 0" notice
 * `verifyReattach` produces once `switch_session` binds to OMP's fresh empty replacement file
 * instead. Checked by `attachAndVerify` before it ever calls `switch_session`. */
export async function assertConversationFileExists(file: string): Promise<void> {
  const exists = await fs.stat(file).then(() => true, () => false);
  if (!exists) throw new Error(`Conversation file missing: ${file}`);
}

/** data-model.md "Reattach verification (FR-013, FR-024)"; only called when resuming.
 * `messageCount` may only grow past `lastMessageCount` in the sense that a drop is never a
 * failure: OMP (its advisor, hooks and background notices) appends messages to a Conversation
 * outside the turn and `session_settled` flow Refract counts, so strict equality would fail a
 * healthy Session after any Stop or Recover -- and Constitution v1.9.0 / FINDINGS item 44 found
 * a live `messageCount` on reattach can also come back BELOW the last known count (observed: two
 * aborted assistant turns dropped on reload), which is likewise not a failure. A `sessionFile`
 * mismatch or a zero count still fail: those mean a truncated, missing, or different file. */
export function verifyReattach(session: Session, state: GetStateResponseData): string | undefined {
  if (path.resolve(state.sessionFile).toLowerCase() !== path.resolve(session.currentConversation!).toLowerCase()) {
    return `Reattach verification failed: sessionFile mismatch (expected ${session.currentConversation}, got ${state.sessionFile})`;
  }
  if (!(state.messageCount > 0)) {
    return `Reattach verification failed: messageCount is ${state.messageCount}, expected greater than 0`;
  }
  return undefined;
}

/** Constitution v1.9.0 / FINDINGS item 44: when a reattach's observed `messageCount` comes back
 * below the Session's last known count, Refract re-baselines `lastMessageCount` to the observed
 * value (`syncFromState` does the actual write) rather than treating it as a failure -- see
 * `verifyReattach`'s doc comment. The caller must tell the user this happened, once, in product
 * wording naming both counts; this only computes that text so it is never fabricated ad hoc at
 * each call site. Returns `undefined` when there is nothing to report (no prior count, or the
 * observed count did not drop). */
export function reattachRebaselineNotice(session: Session, state: GetStateResponseData): string | undefined {
  if (session.lastMessageCount === null || state.messageCount >= session.lastMessageCount) return undefined;
  return `This conversation reconnected with ${state.messageCount} messages instead of the ${session.lastMessageCount} last seen; a few in-progress messages were dropped when it reconnected, but nothing you sent was lost.`;
}
