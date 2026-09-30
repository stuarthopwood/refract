// IPC handlers for `sessions.*` (contracts/ipc.md "Sessions"). Implemented: `create`/`list`/
// `rename` (T022), `open`/`recover` (T022/T045, sharing `openOrRecover`), `archive`/`restore`
// (T041), `deleteCheck`/`delete` (T042), `recreateWorktree` (T043), `stopAgent` (T040), and
// `setVisible` (T036/T037).

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result, SessionSnapshot, SessionRuntimeView } from '../../shared/ipc';
import type { Session } from '../../shared/model';
import { git, GitError } from '../git/git';
import { addWorktree, branchExists, deleteCheck, generateName, recreateWorktree, removeWorktree } from '../git/worktrees';
import { RegistryError } from '../store/registry';
import { listConversations } from '../conversations';
import type { SessionAgent } from '../omp/SessionAgent';
import type { SessionManager } from '../SessionManager';

function invalidArgument(message: string): Result<never> {
  return { ok: false, error: { code: 'invalid-argument', message } };
}

function notFound(message: string): Result<never> {
  return { ok: false, error: { code: 'not-found', message } };
}

function mapThrown(err: unknown): Result<never> {
  if (err instanceof GitError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof RegistryError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: 'git-failed', message: err instanceof Error ? err.message : String(err) } };
}

async function buildSnapshot(agent: SessionAgent, session: Session): Promise<SessionSnapshot> {
  const runtime: SessionRuntimeView = { ...agent.runtimeSnapshot };
  const conversations = await listConversations(session.sessionDir, session.currentConversation);
  return { runtime, conversations };
}

export function registerSessions(manager: SessionManager): void {
  ipcMain.handle(IPC_REQUESTS.SESSIONS_LIST, async () => ({ ok: true, value: manager.summaries() }));

  ipcMain.handle(IPC_REQUESTS.SESSIONS_CREATE, async (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) {
      return invalidArgument(`${IPC_REQUESTS.SESSIONS_CREATE} expects { repositoryId, baseBranch }`);
    }
    const { repositoryId, baseBranch } = input as { repositoryId?: unknown; baseBranch?: unknown };
    if (typeof repositoryId !== 'string' || typeof baseBranch !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.SESSIONS_CREATE} expects { repositoryId: string, baseBranch: string }`);
    }
    const repository = manager.registry.getRepository(repositoryId);
    if (!repository) {
      return notFound(`Repository not found: ${repositoryId}`);
    }
    try {
      const name = await generateName(repository.path);
      const { worktreePath, branch } = await addWorktree(repository.path, name, baseBranch);
      const now = new Date().toISOString();
      const session: Session = {
        id: randomUUID(),
        repositoryId,
        name,
        branch,
        baseBranch,
        worktreePath,
        sessionDir: null,
        currentConversation: null,
        lastMessageCount: null,
        createdAt: now,
        lastActivityAt: now,
        archivedAt: null,
      };
      await manager.registry.addSession(session);
      manager.notifyListChanged();
      return { ok: true, value: session };
    } catch (err) {
      return mapThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_RENAME, async (_event, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.SESSIONS_RENAME} expects (id, name) strings`);
    }
    try {
      await manager.registry.updateSession(id, { name });
      manager.notifyListChanged();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapThrown(err);
    }
  });

  /** Shared by `sessions.open` and `sessions.recover`: both start (or restart, after
   * `agent-exited`) the agent if it is not running and return the resulting snapshot, never an
   * error Result for a start failure -- `start()` already moves the runtime to `stopped` with
   * the specific reason (worktree-missing, start-failed with the stderr tail, ...), and that
   * view IS the documented contract ("or returns the stopped reason"). */
  async function openOrRecover(id: string): Promise<Result<SessionSnapshot>> {
    const session = manager.registry.getSession(id);
    if (!session) return notFound(`Session not found: ${id}`);
    const agent = manager.getOrCreateAgent(id);
    manager.setVisible(id);
    if (agent.runtimeSnapshot.status === 'stopped') {
      await agent.start().catch(() => undefined);
    }
    const refreshed = manager.registry.getSession(id) ?? session;
    return { ok: true, value: await buildSnapshot(agent, refreshed) };
  }

  ipcMain.handle(IPC_REQUESTS.SESSIONS_OPEN, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_OPEN} expects a string id`);
    return openOrRecover(id);
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_ARCHIVE, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_ARCHIVE} expects a string id`);
    if (!manager.registry.getSession(id)) return notFound(`Session not found: ${id}`);
    await manager.getOrCreateAgent(id).shutdown();
    try {
      await manager.registry.updateSession(id, { archivedAt: new Date().toISOString() });
      manager.notifyListChanged();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_RESTORE, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_RESTORE} expects a string id`);
    if (!manager.registry.getSession(id)) return notFound(`Session not found: ${id}`);
    try {
      await manager.registry.updateSession(id, { archivedAt: null });
      manager.notifyListChanged();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_DELETE_CHECK, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_DELETE_CHECK} expects a string id`);
    const session = manager.registry.getSession(id);
    if (!session) return notFound(`Session not found: ${id}`);
    const worktreeExists = await fs.stat(session.worktreePath).then(() => true, () => false);
    if (!worktreeExists) {
      return { ok: true, value: { uncommittedFiles: 0, unpushedCommits: 0, hasUpstream: false } };
    }
    try {
      return { ok: true, value: await deleteCheck(session.worktreePath) };
    } catch (err) {
      return mapThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_DELETE, async (_event, id: unknown, options: unknown) => {
    if (typeof id !== 'string' || typeof options !== 'object' || options === null) {
      return invalidArgument(`${IPC_REQUESTS.SESSIONS_DELETE} expects (id, { confirmed })`);
    }
    if (!('confirmed' in options) || options.confirmed !== true) {
      return invalidArgument(`${IPC_REQUESTS.SESSIONS_DELETE} requires { confirmed: true }`);
    }
    const session = manager.registry.getSession(id);
    if (!session) return notFound(`Session not found: ${id}`);
    const repository = manager.registry.getRepository(session.repositoryId);
    if (!repository) return notFound(`Repository not found: ${session.repositoryId}`);
    await manager.getOrCreateAgent(id).shutdown();
    try {
      const worktreeExists = await fs.stat(session.worktreePath).then(() => true, () => false);
      if (worktreeExists) {
        await removeWorktree(repository.path, session.worktreePath, session.branch, { deleteBranch: true });
      } else if (await branchExists(repository.path, session.branch)) {
        await git(repository.path, ['branch', '-D', session.branch]);
      }
      if (session.sessionDir) {
        await fs.rm(session.sessionDir, { recursive: true, force: true });
      }
      await manager.registry.removeSession(id);
      manager.notifyListChanged();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_RECREATE_WORKTREE, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_RECREATE_WORKTREE} expects a string id`);
    const session = manager.registry.getSession(id);
    if (!session) return notFound(`Session not found: ${id}`);
    const repository = manager.registry.getRepository(session.repositoryId);
    if (!repository) return notFound(`Repository not found: ${session.repositoryId}`);
    try {
      if (!(await branchExists(repository.path, session.branch))) {
        return { ok: false, error: { code: 'branch-missing', message: `Branch not found: ${session.branch}` } };
      }
      await recreateWorktree(repository.path, session.worktreePath, session.branch);
      manager.notifyListChanged();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_RECOVER, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_RECOVER} expects a string id`);
    return openOrRecover(id);
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_STOP_AGENT, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_STOP_AGENT} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    await manager.getOrCreateAgent(sessionId).shutdown();
    return { ok: true, value: undefined };
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_SET_VISIBLE, async (_event, sessionId: unknown) => {
    if (sessionId !== null && typeof sessionId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.SESSIONS_SET_VISIBLE} expects a string id or null`);
    }
    manager.setVisible(sessionId);
    return { ok: true, value: undefined };
  });
}
