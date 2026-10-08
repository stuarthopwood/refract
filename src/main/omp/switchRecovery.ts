// Extracted from `SessionAgent.openConversation`'s failure path (kept SessionAgent.ts under the
// 800-line budget, tasks.md). See `SessionAgent.recoverFromFailedSwitch`'s doc comment for the
// reasoning: restores consistency after a failed post-switch reattach verification by trying to
// switch back to the prior Conversation first, and only recording an unrecoverable failure (the
// caller stops the process and moves the Session to `stopped`/`start-failed`) once that also
// fails or there was no prior Conversation.
import type { OmpProcess } from './OmpProcess';
import { verifyReattach } from './reattachVerification';
import { detectUnexpectedTermination } from './terminationDetection';
import { currentTurnKeys, fromHistory } from './transcript';
import type { GetMessagesResponseData, GetStateResponseData, SwitchSessionResponseData } from '../../shared/frames';
import type { Session, TranscriptItem } from '../../shared/model';

export interface SwitchRecoveryContext {
  process: OmpProcess;
  sessionId: string;
  /** Re-reads the registry's current Session (fresh, in case it changed since the attempt). */
  requireSession: () => Session;
  /** Applies the reloaded transcript on a successful switch-back and flushes a snapshot. */
  applyTranscript: (transcript: TranscriptItem[]) => void;
  /** Clears `process` and records the Session as `stopped`/`start-failed` with `detail`. */
  onUnrecoverable: (detail: string) => void;
}

export async function recoverFromFailedSwitch(
  ctx: SwitchRecoveryContext,
  previousConversation: string | null,
  attemptedFile: string,
  reason: string,
): Promise<void> {
  const { process } = ctx;
  if (previousConversation) {
    try {
      const backRes = await process.request({ type: 'switch_session', id: '', sessionPath: previousConversation });
      const backCancelled = (backRes.data as SwitchSessionResponseData | undefined)?.cancelled;
      if (backRes.success && backCancelled === false) {
        const backStateRes = await process.request({ type: 'get_state', id: '' });
        if (backStateRes.success) {
          const session = ctx.requireSession();
          const backFailure = verifyReattach(session, backStateRes.data as GetStateResponseData);
          if (!backFailure) {
            const messagesRes = await process.request({ type: 'get_messages', id: '' });
            // Issue #489 (durable turn marker, 2026-10-07): scopes by the SAME persisted
            // `currentTurnSubagents` set `reconcileSubagentsOnAttach` uses, read from the
            // `session` just fetched above (fresh, not a stale earlier snapshot).
            const currentTurnKeySet = new Set(currentTurnKeys(session));
            // Issue #510 slice 3 (PLAN.md row A0): `previousConversation` is the file just
            // switched back to -- its own tail decides whether a still-`running` tool row in the
            // reloaded history is settled to `interrupted`.
            const terminatedUnexpectedly = (await detectUnexpectedTermination(previousConversation)).terminatedUnexpectedly;
            const transcript = messagesRes.success
              ? fromHistory((messagesRes.data as GetMessagesResponseData).messages, currentTurnKeySet, terminatedUnexpectedly)
              : [];
            ctx.applyTranscript(transcript);
            return;
          }
        }
      }
    } catch (err) {
      console.error(`SessionAgent ${ctx.sessionId}: failed to switch back after a failed openConversation`, err);
    }
  }
  await process.stop().catch(() => undefined);
  ctx.onUnrecoverable(
    `openConversation(${attemptedFile}) failed reattach verification (${reason}), and recovery to the prior Conversation also failed`,
  );
}
