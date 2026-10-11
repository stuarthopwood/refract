// Shared by the `conversations.open`/`conversations.startNew` IPC handlers for a Session that is
// `stopped` (issue #69). `sessions.open`/`sessions.recover` both only ever retry the SAME saved
// `currentConversation`, so a Session left `stopped` after a failed reattach (a missing
// Conversation file, or any other verification failure) could never reach another Conversation --
// `SessionAgent.openConversation`/`startNewConversation` require an already-idle live process,
// which such a Session can never have again. This updates the registry to the chosen Conversation
// (`file`, or `null` for a brand new one, data-model.md "`currentConversation` ... null before the
// first message") THEN starts the agent, via `SessionAgent.startWith`: that method checks
// synchronously, before any `await`, that nothing is already starting/running and the Session is
// genuinely `stopped`, and only then runs the registry write INSIDE the same in-flight attempt,
// before `doStart()`'s `requireSession()` reads it back. A Session with a start already in flight
// or a live process throws `SessionNotIdleError` instead of silently joining that attempt and
// reattaching the OLD Conversation (the race this fixes); that error propagates so the caller
// maps it to the IPC `not-idle` result. `startWith`'s own `doStart()` rejecting for any other
// reason (a missing worktree, a failed spawn/reattach) already turns into `stopped` with its own
// notice (`SessionAgent.recordStartFailure`), so the caller never needs to treat that as an IPC
// error -- it just returns the resulting snapshot either way, same as before.
import { promises as fs } from 'node:fs';
import { SessionNotIdleError } from './errors';
import type { RegistryStore } from '../store/registry';
import type { SessionAgent } from './SessionAgent';

export async function startStoppedSessionOnConversation(
  registry: RegistryStore,
  agent: SessionAgent,
  sessionId: string,
  file: string | null,
): Promise<void> {
  // Set when the registry write inside `prepare` itself fails: `doStart` never ran, so no notice
  // was recorded and swallowing it would hide the failure behind an unchanged `stopped` snapshot.
  let prepareError: unknown;
  try {
    await agent.startWith(async () => {
      // Skip the registry write when the worktree is missing: there is nothing to reattach to,
      // so clearing `lastMessageCount`/`currentConversation` would just be discarded -- `doStart`
      // already detects this itself and throws, moving the Session to `stopped`/`worktree-missing`.
      const session = registry.getSession(sessionId);
      const worktreeExists = session ? await fs.stat(session.worktreePath).then(() => true, () => false) : false;
      if (!worktreeExists) return;
      const previousConversation = session?.currentConversation ?? null;
      try {
        await registry.updateSession(sessionId, { currentConversation: file, lastMessageCount: null });
      } catch (err) {
        prepareError = err;
        throw err;
      }
      // Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH): round 5 only wired
      // `sideChatConversationChanged` into `SessionAgent.startNewConversation`/`openConversation`
      // -- this is the ONLY Conversation-switch path available while `status === 'stopped'`
      // (`ConversationSwitcher.tsx` allows both New conversation and opening an earlier
      // Conversation from a stopped Session), and it never emitted the event. A stopped Session
      // kept the previous Conversation's side-chat rows and `activeTopicRecordId`, so the next
      // question sent that Conversation's own topic id and OMP rejected it with "Unknown /btw
      // topic" -- the exact defect round 5 claims to have fixed, reachable through another path.
      // Skipped when `file` is the SAME Conversation being reattached (its side-chat topics are
      // still valid), matching `openConversation`'s own `file !== previousConversation` guard.
      if (file === null || file !== previousConversation) {
        agent.notifySideChatConversationChanged();
      }
    });
  } catch (err) {
    // A failed start (missing worktree, spawn/reattach failure) already landed the Session in
    // `stopped` with its own notice -- swallow it, same as the old `.catch(() => undefined)`.
    // A `SessionNotIdleError` means `startWith` refused to even attempt it (already starting, or
    // somehow already live): that must surface so the handler maps it to `not-idle`. A failed
    // registry write must surface too (the handler maps it through `mapSessionThrown`).
    if (err instanceof SessionNotIdleError) throw err;
    if (prepareError !== undefined) throw prepareError;
  }
}
