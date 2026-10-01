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
 * `messageCount` may only grow past `lastMessageCount`: OMP (its advisor, hooks and background
 * notices) appends messages to a Conversation outside the turn and `session_settled` flow Pinion
 * counts, so strict equality would fail a healthy Session after any Stop or Recover. A count
 * BELOW the last known one still fails: that is a truncated or different file. */
export function verifyReattach(session: Session, state: GetStateResponseData): string | undefined {
  if (path.resolve(state.sessionFile).toLowerCase() !== path.resolve(session.currentConversation!).toLowerCase()) {
    return `Reattach verification failed: sessionFile mismatch (expected ${session.currentConversation}, got ${state.sessionFile})`;
  }
  if (!(state.messageCount > 0)) {
    return `Reattach verification failed: messageCount is ${state.messageCount}, expected greater than 0`;
  }
  if (session.lastMessageCount !== null && state.messageCount < session.lastMessageCount) {
    return `Reattach verification failed: messageCount ${state.messageCount} is below last known ${session.lastMessageCount}`;
  }
  return undefined;
}
