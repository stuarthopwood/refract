// IPC handlers for `sideChat.*` (contracts/ipc.md "Side chat", spec 014 tasks.md T011-T013).
// Mirrors `chat.ts`'s validation and error-mapping shape for the same underlying `SessionAgent`
// error classes (`AgentNotRunningError`/`PromptFailedError`): `askSideChat`/`cancelSideChat`/
// `getSideChatHistory` all drive an already-attached process exactly like `chat.send`/`chat.stop`
// do, never a Conversation reattach, so their default error code is `prompt-failed` too.
// Gate-fix (round 2, Code2 Medium): reuses `chat.ts`'s own `mapChatError` instead of keeping a
// word-for-word copy.

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { SideChatRecord } from '../../shared/frames';
import { invalidArgument, notFound } from './util';
import { mapChatError } from './chat';
import type { SessionManager } from '../SessionManager';

// No OMP-documented limit exists for `btw`'s `question` field (contracts/ipc.md has no stated
// maximum). 10,000 characters comfortably covers any realistic side question while still
// bounding a pathological paste before it ever reaches OMP (main-side validation, Main's remit).
const SIDE_CHAT_MAX_QUESTION_LENGTH = 10_000;
// `recordId` is OMP's own opaque record id (observed live as a short hex string, FINDINGS item
// 14); 200 characters is a generous upper bound that still catches a malformed/oversized value
// before it reaches OMP (gate-fix round 2, Sec2 LOW).
const SIDE_CHAT_MAX_RECORD_ID_LENGTH = 200;

export function registerSideChat(manager: SessionManager): void {
  // contracts/ipc.md "Error codes added": a blank `question` is rejected locally with
  // `invalid-argument` before ever reaching OMP -- one of `btw`'s own documented failure cases
  // (issue://516), caught client-side to avoid a round trip for a case Refract can already
  // detect. `recordId` omitted starts a fresh topic (FR-003); given, continues one.
  ipcMain.handle(IPC_REQUESTS.SIDE_CHAT_ASK, async (_event, sessionId: unknown, question: unknown, recordId: unknown) => {
    if (typeof sessionId !== 'string' || typeof question !== 'string' || (recordId !== undefined && typeof recordId !== 'string')) {
      // Gate-fix (round 4, Sec4 Low): these four messages reach the renderer's own toast
      // verbatim (`sideChat.ask`'s `invalid-argument` result, same path as any other failure) --
      // plain English, never the internal IPC channel name a developer never asked about.
      return invalidArgument('sideChat.ask expects (sessionId, question, recordId?) strings');
    }
    if (question.trim().length === 0) {
      return invalidArgument('A side question must not be blank');
    }
    if (question.length > SIDE_CHAT_MAX_QUESTION_LENGTH) {
      return invalidArgument(`A side question must not exceed ${SIDE_CHAT_MAX_QUESTION_LENGTH} characters`);
    }
    if (recordId !== undefined && (recordId.length === 0 || recordId.length > SIDE_CHAT_MAX_RECORD_ID_LENGTH)) {
      return invalidArgument(`recordId must be 1-${SIDE_CHAT_MAX_RECORD_ID_LENGTH} characters when given`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      const result = await manager.getOrCreateAgent(sessionId).askSideChat(question, recordId);
      return { ok: true, value: result };
    } catch (err) {
      return mapChatError(err);
    }
  });

  // contracts/ipc.md: a no-op (not an error) if nothing is running -- mirrors
  // `subagents.cancel`'s own idempotent shape; `cancelSideChat` itself no-ops with no live
  // process instead of throwing `AgentNotRunningError`.
  ipcMain.handle(IPC_REQUESTS.SIDE_CHAT_CANCEL, async (_event, sessionId: unknown) => {
    // Gate-fix (round 5, Verif5/Sec5 Low): plain English, matching `sideChat.ask`'s own fix
    // (round 4) -- these messages can reach the renderer's own toast verbatim.
    if (typeof sessionId !== 'string') return invalidArgument('Cancelling a side question needs a Session id');
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      await manager.getOrCreateAgent(sessionId).cancelSideChat();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapChatError(err);
    }
  });

  // contracts/ipc.md, FR-004: every side-chat record OMP has for this Session's saved session
  // file. Called once per Session per app run by the renderer store, not polled. A Session with
  // no live process yet still returns the `agent-not-running` error code (not a silent empty
  // list) -- gate-fix round 2 (Code2/Sec2 Medium): the store reads this specific code to retry
  // once the Session actually starts, instead of wrongly caching "no history" forever.
  ipcMain.handle(IPC_REQUESTS.SIDE_CHAT_GET_HISTORY, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument('Loading side chat history needs a Session id');
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      const records: SideChatRecord[] = await manager.getOrCreateAgent(sessionId).getSideChatHistory();
      return { ok: true, value: records };
    } catch (err) {
      return mapChatError(err);
    }
  });
}
