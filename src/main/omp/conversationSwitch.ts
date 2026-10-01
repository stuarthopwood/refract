// Shared by the `conversations.open`/`conversations.startNew` IPC handlers for a Session that is
// `stopped` (issue #69). `sessions.open`/`sessions.recover` both only ever retry the SAME saved
// `currentConversation`, so a Session left `stopped` after a failed reattach (a missing
// Conversation file, or any other verification failure) could never reach another Conversation --
// `SessionAgent.openConversation`/`startNewConversation` require an already-idle live process,
// which such a Session can never have again. This updates the registry to the chosen Conversation
// FIRST (`file`, or `null` for a brand new one, data-model.md "`currentConversation` ... null
// before the first message"), then starts the agent: `SessionAgent.start()` spawns a fresh
// process and reattaches (or starts blank) against that file, running the same reattach
// verification as any other start. A failed attempt already turns into `stopped` with its own
// notice (`SessionAgent.recordStartFailure`) instead of rejecting, so the caller never needs to
// treat this failing as an IPC error -- it just returns the resulting snapshot either way.
import type { RegistryStore } from '../store/registry';
import type { SessionAgent } from './SessionAgent';

export async function startStoppedSessionOnConversation(
  registry: RegistryStore,
  agent: SessionAgent,
  sessionId: string,
  file: string | null,
): Promise<void> {
  await registry.updateSession(sessionId, { currentConversation: file, lastMessageCount: null });
  await agent.start().catch(() => undefined);
}
