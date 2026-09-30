// IPC handlers for `conversations.*` (contracts/ipc.md "Conversations", tasks.md T027). Scanning
// lives in `../conversations.ts`; `startNew`/`open` drive the live process via `SessionAgent`.

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result, SessionSnapshot, SessionRuntimeView } from '../../shared/ipc';
import type { Session } from '../../shared/model';
import { listConversations } from '../conversations';
import { ReattachFailedError, SessionNotIdleError } from '../omp/SessionAgent';
import type { SessionAgent } from '../omp/SessionAgent';
import type { SessionManager } from '../SessionManager';

function invalidArgument(message: string): Result<never> {
  return { ok: false, error: { code: 'invalid-argument', message } };
}

function notFound(message: string): Result<never> {
  return { ok: false, error: { code: 'not-found', message } };
}

function mapThrown(err: unknown): Result<never> {
  if (err instanceof SessionNotIdleError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof ReattachFailedError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) } };
}

async function buildSnapshot(agent: SessionAgent, session: Session): Promise<SessionSnapshot> {
  const runtime: SessionRuntimeView = { ...agent.runtimeSnapshot };
  const conversations = await listConversations(session.sessionDir, session.currentConversation);
  return { runtime, conversations };
}

export function registerConversations(manager: SessionManager): void {
  ipcMain.handle(IPC_REQUESTS.CONVERSATIONS_LIST, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CONVERSATIONS_LIST} expects a string sessionId`);
    }
    const session = manager.registry.getSession(sessionId);
    if (!session) return notFound(`Session not found: ${sessionId}`);
    return { ok: true, value: await listConversations(session.sessionDir, session.currentConversation) };
  });

  ipcMain.handle(IPC_REQUESTS.CONVERSATIONS_START_NEW, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CONVERSATIONS_START_NEW} expects a string sessionId`);
    }
    const session = manager.registry.getSession(sessionId);
    if (!session) return notFound(`Session not found: ${sessionId}`);
    const agent = manager.getOrCreateAgent(sessionId);
    try {
      await agent.startNewConversation();
    } catch (err) {
      return mapThrown(err);
    }
    const refreshed = manager.registry.getSession(sessionId) ?? session;
    return { ok: true, value: await buildSnapshot(agent, refreshed) };
  });

  ipcMain.handle(IPC_REQUESTS.CONVERSATIONS_OPEN, async (_event, sessionId: unknown, file: unknown) => {
    if (typeof sessionId !== 'string' || typeof file !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CONVERSATIONS_OPEN} expects (sessionId, file) strings`);
    }
    const session = manager.registry.getSession(sessionId);
    if (!session) return notFound(`Session not found: ${sessionId}`);
    const agent = manager.getOrCreateAgent(sessionId);
    try {
      await agent.openConversation(file);
    } catch (err) {
      return mapThrown(err);
    }
    const refreshed = manager.registry.getSession(sessionId) ?? session;
    return { ok: true, value: await buildSnapshot(agent, refreshed) };
  });
}
