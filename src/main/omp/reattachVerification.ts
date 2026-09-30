import path from 'node:path';
import type { GetStateResponseData } from '../../shared/frames';
import type { Session } from '../../shared/model';

/** data-model.md "Reattach verification (FR-013, FR-024)"; only called when resuming. */
export function verifyReattach(session: Session, state: GetStateResponseData): string | undefined {
  if (path.resolve(state.sessionFile).toLowerCase() !== path.resolve(session.currentConversation!).toLowerCase()) {
    return `Reattach verification failed: sessionFile mismatch (expected ${session.currentConversation}, got ${state.sessionFile})`;
  }
  if (!(state.messageCount > 0)) {
    return `Reattach verification failed: messageCount is ${state.messageCount}, expected greater than 0`;
  }
  if (session.lastMessageCount !== null && state.messageCount !== session.lastMessageCount) {
    return `Reattach verification failed: messageCount ${state.messageCount} does not match last known ${session.lastMessageCount}`;
  }
  return undefined;
}
