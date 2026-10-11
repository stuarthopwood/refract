// IPC handlers for `sideChat.*` (contracts/ipc.md "Side chat", spec 014 tasks.md T011-T013).
// Mirrors `chat.ts`'s validation and error-mapping shape for the same underlying `SessionAgent`
// error classes (`AgentNotRunningError`/`PromptFailedError`): `askSideChat`/`cancelSideChat`/
// `getSideChatHistory` all drive an already-attached process exactly like `chat.send`/`chat.stop`
// do, never a Conversation reattach, so their default error code is `prompt-failed` too.

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { SideChatRecord } from '../../shared/frames';
import { AgentNotRunningError, PromptFailedError } from '../omp/errors';
import { invalidArgument, notFound } from './util';
import type { SessionManager } from '../SessionManager';

// No OMP-documented limit exists for `btw`'s `question` field (contracts/ipc.md has no stated
// maximum). 10,000 characters comfortably covers any realistic side question while still
// bounding a pathological paste before it ever reaches OMP (main-side validation, Main's remit).
const SIDE_CHAT_MAX_QUESTION_LENGTH = 10_000;

function mapSideChatError(err: unknown): Result<never> {
  if (err instanceof AgentNotRunningError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof PromptFailedError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) } };
}

export function registerSideChat(manager: SessionManager): void {
  // contracts/ipc.md "Error codes added": a blank `question` is rejected locally with
  // `invalid-argument` before ever reaching OMP -- one of `btw`'s own documented failure cases
  // (issue://516), caught client-side to avoid a round trip for a case Refract can already
  // detect. `recordId` omitted starts a fresh topic (FR-003); given, continues one.
  ipcMain.handle(IPC_REQUESTS.SIDE_CHAT_ASK, async (_event, sessionId: unknown, question: unknown, recordId: unknown) => {
    if (typeof sessionId !== 'string' || typeof question !== 'string' || (recordId !== undefined && typeof recordId !== 'string')) {
      return invalidArgument(`${IPC_REQUESTS.SIDE_CHAT_ASK} expects (sessionId, question, recordId?) strings`);
    }
    if (question.trim().length === 0) {
      return invalidArgument(`${IPC_REQUESTS.SIDE_CHAT_ASK}: question must not be blank`);
    }
    if (question.length > SIDE_CHAT_MAX_QUESTION_LENGTH) {
      return invalidArgument(`${IPC_REQUESTS.SIDE_CHAT_ASK}: question exceeds ${SIDE_CHAT_MAX_QUESTION_LENGTH} characters`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      const result = await manager.getOrCreateAgent(sessionId).askSideChat(question, recordId);
      return { ok: true, value: result };
    } catch (err) {
      return mapSideChatError(err);
    }
  });

  // contracts/ipc.md: a no-op (not an error) if nothing is running -- mirrors
  // `subagents.cancel`'s own idempotent shape; `cancelSideChat` itself no-ops with no live
  // process instead of throwing `AgentNotRunningError`.
  ipcMain.handle(IPC_REQUESTS.SIDE_CHAT_CANCEL, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.SIDE_CHAT_CANCEL} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      await manager.getOrCreateAgent(sessionId).cancelSideChat();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapSideChatError(err);
    }
  });

  // contracts/ipc.md, FR-004: every side-chat record OMP has for this Session's saved session
  // file. Called once per Session per app run by the renderer store, not polled.
  ipcMain.handle(IPC_REQUESTS.SIDE_CHAT_GET_HISTORY, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.SIDE_CHAT_GET_HISTORY} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      const records: SideChatRecord[] = await manager.getOrCreateAgent(sessionId).getSideChatHistory();
      return { ok: true, value: records };
    } catch (err) {
      return mapSideChatError(err);
    }
  });
}
