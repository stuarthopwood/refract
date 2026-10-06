// IPC handlers for `sessions.*` (contracts/ipc.md "Sessions"). Implemented: `create`/`list`/
// `rename` (T022), `open`/`recover` (T022/T045, sharing `attachSnapshot`; `open` only
// auto-starts a Session that was never wrong -- `canAutoStart` -- `recover` always restarts),
// `archive`/`restore` (T041), `deleteCheck`/`delete` (T042), `recreateWorktree` (T043),
// `stopAgent` (T040), `setVisible` (T036/T037), and `diffStat`/`revealWorktree` (T068).

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { DiffStat, Result, SessionSnapshot, SessionRuntimeView } from '../../shared/ipc';
import { git } from '../git/git';
import { diffStat } from '../git/diffStat';
import { addWorktree, branchExists, deleteCheck, generateName, listBranches, recreateWorktree, removeWorktree } from '../git/worktrees';
import type { Session } from '../../shared/model';
import { listConversations } from '../conversations';
import type { SessionManager } from '../SessionManager';
import { buildSnapshot, invalidArgument, mapStoreThrown, notFound } from './util';

/** Security: a Session's `sessionDir` is learned from OMP's own `get_state`, but the registry
 * is just a JSON file -- a corrupted or hand-edited one must never make `sessions.delete`
 * `fs.rm` an arbitrary path. Only a true descendant of the real OMP sessions root (never the
 * root itself) is ever touched. */
function isStrictDescendantOfOmpSessions(dir: string): boolean {
  const sessionsRoot = path.resolve(os.homedir(), '.omp', 'agent', 'sessions').toLowerCase();
  const resolved = path.resolve(dir).toLowerCase();
  return resolved !== sessionsRoot && resolved.startsWith(`${sessionsRoot}${path.sep}`);
}

/** Deletes only this Session's own Conversation files (`*.jsonl`) and their sibling same-stem
 * directories (subagent transcripts, data-model.md), then removes `sessionDir` itself only once
 * it is empty -- never a wholesale recursive `fs.rm(sessionDir)`, which could take unrelated
 * sibling Conversations or (if `sessionDir` were ever wrong) far more than that. */
async function deleteSessionConversations(sessionDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.jsonl')) continue;
    const filePath = path.join(sessionDir, entry);
    const siblingDir = path.join(sessionDir, entry.slice(0, -'.jsonl'.length));
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    await fs.rm(siblingDir, { recursive: true, force: true }).catch(() => undefined);
  }
  try {
    const remaining = await fs.readdir(sessionDir);
    if (remaining.length === 0) {
      await fs.rmdir(sessionDir);
    }
  } catch {
    // Not empty (something Refract didn't create is in there), already gone, or some other
    // filesystem issue: leave it. Never force-remove a directory that is not provably empty.
  }
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
      const branches = await listBranches(repository.path);
      if (!branches.includes(baseBranch)) {
        return { ok: false, error: { code: 'base-missing', message: `Base branch not found: ${baseBranch}` } };
      }
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
      try {
        await manager.registry.addSession(session);
      } catch (err) {
        // Security remediation (Medium): `addSession` can now fail with `not-found` when the
        // Repository was removed while `listBranches`/`generateName`/`addWorktree` above were
        // still in flight -- without this, the worktree/branch just created above would be
        // stranded (orphaned, no Session pointing at them). Reuses the same removal helper
        // `sessions.delete` already uses, rather than a second cleanup path.
        await removeWorktree(repository.path, worktreePath, branch, { deleteBranch: true }).catch(() => undefined);
        return mapStoreThrown(err);
      }
      manager.notifyListChanged();
      return { ok: true, value: session };
    } catch (err) {
      return mapStoreThrown(err);
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
      return mapStoreThrown(err);
    }
  });

  /** `sessions.open` auto-starts a stopped Session only when nothing is wrong with the agent
   * itself: never started this run, or stopped on request (`SessionAgent.onExit`'s requested
   * branch uses `stopReason: 'not-started'` for both). `worktree-missing` also still auto-starts
   * here (unchanged; T043 owns that state's dedicated Recreate/Archive/Delete actions, not this
   * gate). `agent-exited` and `start-failed` must NOT auto-start (FR-034): the crashed/failed
   * agent stays visibly stopped, with its `stopReason`/`stopDetail` (including the stderr tail),
   * until the user explicitly asks `sessions.recover`. */
  function canAutoStart(stopReason: SessionRuntimeView['stopReason']): boolean {
    return stopReason === undefined || stopReason === 'not-started' || stopReason === 'worktree-missing';
  }

  /** Shared by `sessions.open` and `sessions.recover`: both return the resulting snapshot, never
   * an error Result for a start failure -- `start()` already moves the runtime to `stopped` with
   * the specific reason (worktree-missing, start-failed with the stderr tail, ...), and that view
   * IS the documented contract ("or returns the stopped reason"). `forceStart` makes `recover`
   * restart regardless of reason (including `agent-exited`); `open` only starts when
   * `canAutoStart` says the Session was never wrong to begin with. */
  async function attachSnapshot(id: string, forceStart: boolean): Promise<Result<SessionSnapshot>> {
    const session = manager.registry.getSession(id);
    if (!session) return notFound(`Session not found: ${id}`);
    const agent = manager.getOrCreateAgent(id);
    // Visibility is NOT set here. It is set solely by the explicit `sessions.setVisible` IPC.
    // Round 3 (code-reviewer, Low): App.tsx's own rendered-panes effect is the SOLE caller now,
    // and it fires AFTER this call's snapshot resolves (reacting to the resulting state change),
    // not before as sessions-store.ts/split-store.ts used to. Calling `manager.setVisible(id)`
    // here too used to run synchronously ahead of `agent.start()` resolving (~16s on a cold
    // start) while the renderer's own visible-Session state did not flip until this whole IPC
    // round-trip returned: main and the renderer disagreed about which Session was visible for
    // the entire cold start (bug report point 5).
    if (agent.runtimeSnapshot.status === 'stopped' && (forceStart || canAutoStart(agent.runtimeSnapshot.stopReason))) {
      await agent.start().catch(() => undefined);
      // T062: `agent.start()` runs `syncFromState` against the registry before resolving
      // (`lastModel`/`lastThinkingLevel`, `sessionDir`, ...), so the row the renderer already
      // cached from a previous `sessions.list()` is now stale; tell it to re-fetch, the same way
      // every other Session-row-affecting mutation in this file already does.
      manager.notifyListChanged();
    }
    const refreshed = manager.registry.getSession(id) ?? session;
    return { ok: true, value: await buildSnapshot(agent, refreshed) };
  }

  ipcMain.handle(IPC_REQUESTS.SESSIONS_OPEN, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_OPEN} expects a string id`);
    return attachSnapshot(id, false);
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
      return mapStoreThrown(err);
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
      return mapStoreThrown(err);
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
      return mapStoreThrown(err);
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
        if (isStrictDescendantOfOmpSessions(session.sessionDir)) {
          await deleteSessionConversations(session.sessionDir);
        } else {
          console.warn(`sessions.delete: refusing to delete sessionDir outside ~/.omp/agent/sessions: ${session.sessionDir}`);
        }
      }
      await manager.registry.removeSession(id);
      manager.removeAgent(id);
      manager.notifyListChanged();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
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
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_RECOVER, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_RECOVER} expects a string id`);
    return attachSnapshot(id, true);
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_STOP_AGENT, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_STOP_AGENT} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    await manager.getOrCreateAgent(sessionId).shutdown();
    return { ok: true, value: undefined };
  });

  // Spec 005 contracts/ipc.md: sessionIds is every session id currently shown in any pane
  // (0, 1, or 2 elements), replacing the single-id/null form. Quality-gate remediation
  // (security-auditor, Low): capped at 2 (the contract's own stated maximum) and validated by
  // direct index reads, never `.every()`, which silently skips a sparse array's holes (a hole
  // would otherwise become a real `undefined` entry in `SessionManager`'s visible-ids Set).
  ipcMain.handle(IPC_REQUESTS.SESSIONS_SET_VISIBLE, async (_event, sessionIds: unknown) => {
    let valid = Array.isArray(sessionIds) && sessionIds.length <= 2;
    if (valid) {
      for (let index = 0; index < (sessionIds as unknown[]).length; index += 1) {
        if (typeof (sessionIds as unknown[])[index] !== 'string') {
          valid = false;
          break;
        }
      }
    }
    if (!valid) {
      return invalidArgument(`${IPC_REQUESTS.SESSIONS_SET_VISIBLE} expects a string[] of at most 2 ids`);
    }
    manager.setVisible(sessionIds as string[]);
    return { ok: true, value: undefined };
  });

  // T068: read-only, so never throws past `diffStat` itself -- a timeout, a missing worktree, a
  // missing Base branch, or any git failure all come back as `null`, a normal `ok: true` value.
  ipcMain.handle(IPC_REQUESTS.SESSIONS_DIFF_STAT, async (_event, id: unknown): Promise<Result<DiffStat | null>> => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_DIFF_STAT} expects a string id`);
    const session = manager.registry.getSession(id);
    if (!session) return notFound(`Session not found: ${id}`);
    const value = await diffStat(session.worktreePath, session.baseBranch);
    return { ok: true, value };
  });

  // T068: looks the worktree up by Session id in the registry, never a path handed in by the
  // renderer (constitution V). `shell.openPath` returns an error string (never throws) on
  // failure instead of an empty one on success.
  ipcMain.handle(IPC_REQUESTS.SESSIONS_REVEAL_WORKTREE, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_REVEAL_WORKTREE} expects a string id`);
    const session = manager.registry.getSession(id);
    if (!session) return notFound(`Session not found: ${id}`);
    const worktreeIsDirectory = await fs.stat(session.worktreePath).then(
      (stat) => stat.isDirectory(),
      () => false
    );
    if (!worktreeIsDirectory) {
      return { ok: false, error: { code: 'worktree-missing', message: `Worktree missing: ${session.worktreePath}` } };
    }
    const openError = await shell.openPath(session.worktreePath);
    if (openError) return { ok: false, error: { code: 'worktree-failed', message: openError } };
    return { ok: true, value: undefined };
  });
}
