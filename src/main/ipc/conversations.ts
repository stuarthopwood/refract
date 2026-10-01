// IPC handlers for `conversations.*` (contracts/ipc.md "Conversations", tasks.md T027). Scanning
// lives in `../conversations.ts`; `startNew`/`open` drive the live process via `SessionAgent`.
// For a Session that is `stopped` (no live process) both instead go through
// `startStoppedSessionOnConversation` (issue #69): `SessionAgent.startNewConversation`/
// `openConversation` require an already-idle live process, which a stopped Session never has.

import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import { listConversations } from '../conversations';
import { startStoppedSessionOnConversation } from '../omp/conversationSwitch';
import type { SessionManager } from '../SessionManager';
import { buildSnapshot, invalidArgument, mapSessionThrown, notFound } from './util';

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
      if (agent.runtimeSnapshot.status === 'stopped') {
        await startStoppedSessionOnConversation(manager.registry, agent, sessionId, null);
      } else {
        await agent.startNewConversation();
      }
    } catch (err) {
      return mapSessionThrown(err);
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
    // Security: `file` is renderer-supplied; only accept a path this Session's own scan already
    // returned, never an arbitrary filesystem path (another Session's Conversation, or anything
    // else readable by the process).
    const ownConversations = await listConversations(session.sessionDir, session.currentConversation);
    const resolvedFile = path.resolve(file);
    const match = ownConversations.find((c) => path.resolve(c.file).toLowerCase() === resolvedFile.toLowerCase());
    if (!match) {
      return invalidArgument(`${IPC_REQUESTS.CONVERSATIONS_OPEN} file must be one of this Session's own Conversations`);
    }
    const agent = manager.getOrCreateAgent(sessionId);
    try {
      if (agent.runtimeSnapshot.status === 'stopped') {
        await startStoppedSessionOnConversation(manager.registry, agent, sessionId, match.file);
      } else {
        await agent.openConversation(match.file);
      }
    } catch (err) {
      return mapSessionThrown(err);
    }
    const refreshed = manager.registry.getSession(sessionId) ?? session;
    return { ok: true, value: await buildSnapshot(agent, refreshed) };
  });
}
