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
  try {
    await agent.startWith(async () => {
      // Skip the registry write when the worktree is missing: there is nothing to reattach to,
      // so clearing `lastMessageCount`/`currentConversation` would just be discarded -- `doStart`
      // already detects this itself and throws, moving the Session to `stopped`/`worktree-missing`.
      const session = registry.getSession(sessionId);
      const worktreeExists = session ? await fs.stat(session.worktreePath).then(() => true, () => false) : false;
      if (!worktreeExists) return;
      await registry.updateSession(sessionId, { currentConversation: file, lastMessageCount: null });
    });
  } catch (err) {
    // A failed start (missing worktree, spawn/reattach failure) already landed the Session in
    // `stopped` with its own notice -- swallow it, same as the old `.catch(() => undefined)`.
    // A `SessionNotIdleError` means `startWith` refused to even attempt it (already starting, or
    // somehow already live): that must surface so the handler maps it to `not-idle`.
    if (err instanceof SessionNotIdleError) throw err;
  }
}
