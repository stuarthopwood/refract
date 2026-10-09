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
import { diffStat } from '../git/diffStat';
import {
  addWorktree,
  branchExists,
  deleteCheck,
  deleteCheckForMissingWorktree,
  generateName,
  listBranches,
  recreateWorktree,
  removeSessionWorktree,
  removeWorktree
} from '../git/worktrees';
import type { Session } from '../../shared/model';
import { listConversations } from '../conversations';
import { detectUnexpectedTermination } from '../omp/terminationDetection';
import type { SessionManager } from '../SessionManager';
import { buildSnapshot, invalidArgument, mapStoreThrown, notFound } from './util';
import { attachSnapshotCore } from './attachSnapshot';
import { resumeSessionCore, BUSY_MESSAGE } from './resumeSession';
import type { SessionAgent } from '../omp/SessionAgent';

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
  ipcMain.handle(IPC_REQUESTS.SESSIONS_LIST, async () => ({ ok: true, value: await manager.summaries() }));

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
        // stranded (orphaned, no Session pointing at them). Reuses the same `git worktree
        // remove --force` helper `removeSessionWorktree` falls back to for a registered
        // worktree (this one always is, having just been created), rather than a second
        // cleanup path.
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

  /** Shared by `sessions.open` and `sessions.recover`: both return the resulting snapshot, never
   * an error Result for a start failure -- `start()` already moves the runtime to `stopped` with
   * the specific reason (worktree-missing, start-failed with the stderr tail, ...), and that view
   * IS the documented contract ("or returns the stopped reason"). `forceStart` makes `recover`
   * (and an explicit user send, see `SESSIONS_OPEN` below) restart regardless of reason (including
   * `agent-exited`); a passive `open` only starts when `canAutoStart` says the Session was never
   * wrong to begin with. The tail detection is computed at most once here and threaded into
   * `buildSnapshot` (quality-gate fix: avoids a second 256 KiB read of the same file). */
  async function attachSnapshot(id: string, forceStart: boolean): Promise<Result<SessionSnapshot>> {
    // Quality-gate fix (cycle 3, 2026-10-08): the actual logic (the `stoppedOnRequest`
    // short-circuit, the `canAutoStart` gate, threading `detection` into `buildSnapshot`) now
    // lives in `attachSnapshotCore` (`attachSnapshot.ts`), injected with this manager's own real
    // dependencies, so it is unit-testable against fakes -- same reasoning as `resumeSessionCore`.
    // Visibility is NOT set here. It is set solely by the explicit `sessions.setVisible` IPC.
    // Round 3 (code-reviewer, Low): App.tsx's own rendered-panes effect is the SOLE caller now,
    // and it fires AFTER this call's snapshot resolves (reacting to the resulting state change),
    // not before as sessions-store.ts/split-store.ts used to. Calling `manager.setVisible(id)`
    // here too used to run synchronously ahead of `agent.start()` resolving (~16s on a cold
    // start) while the renderer's own visible-Session state did not flip until this whole IPC
    // round-trip returned: main and the renderer disagreed about which Session was visible for
    // the entire cold start (bug report point 5).
    return attachSnapshotCore(id, forceStart, {
      getSession: (sessionId) => manager.registry.getSession(sessionId),
      getOrCreateAgent: (sessionId) => manager.getOrCreateAgent(sessionId),
      notifyListChanged: () => manager.notifyListChanged(),
      detectUnexpectedTermination,
      buildSnapshot: (agent, session, detection) => buildSnapshot(agent as SessionAgent, session, detection),
    });
  }

  ipcMain.handle(IPC_REQUESTS.SESSIONS_OPEN, async (_event, id: unknown, userAction: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_OPEN} expects a string id`);
    // Quality-gate fix (#509): an explicit user action (typing a message and sending it to a
    // not-yet-opened pane, MessageInput's own `notStarted` path) must still start the agent even
    // for a Session `canAutoStart` would otherwise leave stopped -- that passive gate exists to
    // stop a SILENT background auto-start, never to block the user's own direct request. Treated
    // exactly like `recover`'s `forceStart`.
    return attachSnapshot(id, userAction === true);
  });

  // Issue #603 quality-gate follow-up (Medium, security): `resumingIds` is shared with
  // SESSIONS_RESUME (declared once, here, so every handler below can see it) -- a resume whose
  // own tail read finishes while THIS handler's `shutdown()` below is still in flight used to
  // pass its archived check, start a new omp process and send the resume turn into a Session
  // this call was about to mark archived. Checking and holding the same lock here closes that
  // window: a resume already in progress refuses SESSIONS_ARCHIVE outright (and vice versa,
  // via `checkResumeEligible`'s own `resumingIds.has(id)` check), rather than racing it.
  const resumingIds = new Set<string>();
  ipcMain.handle(IPC_REQUESTS.SESSIONS_ARCHIVE, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_ARCHIVE} expects a string id`);
    if (!manager.registry.getSession(id)) return notFound(`Session not found: ${id}`);
    if (resumingIds.has(id)) {
      return { ok: false, error: { code: 'invalid-argument', message: BUSY_MESSAGE } };
    }
    resumingIds.add(id);
    try {
      await manager.getOrCreateAgent(id).shutdown();
      try {
        await manager.registry.updateSession(id, { archivedAt: new Date().toISOString() });
        manager.notifyListChanged();
        return { ok: true, value: undefined };
      } catch (err) {
        return mapStoreThrown(err);
      }
    } finally {
      resumingIds.delete(id);
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
      // Issue #599: a missing folder used to report zero risk unconditionally, even though
      // `removeSessionWorktree` can still force-remove a registered worktree entry and
      // `branch -D` the branch underneath it. Read the real risk from the repository and
      // branch instead of assuming none.
      const repository = manager.registry.getRepository(session.repositoryId);
      if (!repository) return notFound(`Repository not found: ${session.repositoryId}`);
      try {
        return { ok: true, value: await deleteCheckForMissingWorktree(repository.path, session.branch) };
      } catch (err) {
        return mapStoreThrown(err);
      }
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
    // Issue #603 quality-gate follow-up (Medium, security): same shared lock as
    // SESSIONS_ARCHIVE -- refuses while a resume is in progress for this Session, rather than
    // racing a resume whose tail read finishes while `shutdown()` below is still in flight,
    // which used to be able to start a new omp process in a worktree this call is about to
    // remove.
    if (resumingIds.has(id)) {
      return { ok: false, error: { code: 'invalid-argument', message: BUSY_MESSAGE } };
    }
    resumingIds.add(id);
    try {
      await manager.getOrCreateAgent(id).shutdown();
      try {
        // Issue #599 quality-gate fix: decide by `git worktree list --porcelain`, never
        // `fs.stat` -- an orphaned folder (left behind by a crash, a manual `git worktree
        // prune`, or hand cleanup) still exists on disk while git has already lost track of
        // it, and the old `fs.stat`-then-`removeWorktree` path threw on that state with no
        // retry. `removeSessionWorktree` (`git/worktrees.ts`) owns the full registered/
        // unregistered decision and the folder-removal safety checks.
        await removeSessionWorktree(repository.path, session.worktreePath, session.branch, { deleteBranch: true });
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
    } finally {
      resumingIds.delete(id);
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

  // Issue #509 (PLAN.md row A2g) quality-gate fix: one in-main resume path, never two renderer
  // call sites (the row button and the stop banner) each doing their own recover-then-send --
  // `resumingIds` (declared above, shared with SESSIONS_ARCHIVE/SESSIONS_DELETE -- issue #603)
  // is a per-session server-side lock so a double click (one from each UI entry point, or two
  // in a row before the busy state renders) can only ever send the instruction once. Re-checks
  // `canResumeSession` here too, against a fresh tail read, rather than trusting whatever
  // `SessionSummary` the renderer's click happened to be holding -- a second pane could have
  // already recovered this exact Session in the meantime. Quality-gate fix (cycle 2,
  // 2026-10-08): the actual logic lives in `resumeSessionCore` (`resumeSession.ts`), injected
  // with this manager's own real dependencies, so it is unit-testable against fakes.
  ipcMain.handle(IPC_REQUESTS.SESSIONS_RESUME, async (_event, id: unknown) => {
    if (typeof id !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_RESUME} expects a string id`);
    return resumeSessionCore(resumingIds, id, {
      getSession: (sessionId) => manager.registry.getSession(sessionId),
      getOrCreateAgent: (sessionId) => manager.getOrCreateAgent(sessionId),
      notifyListChanged: () => manager.notifyListChanged(),
      detectUnexpectedTermination,
      buildSnapshot: (agent, session) => buildSnapshot(agent as SessionAgent, session),
    });
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_STOP_AGENT, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_STOP_AGENT} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    await manager.getOrCreateAgent(sessionId).shutdown();
    return { ok: true, value: undefined };
  });

  // Issue #512: "Keep waiting" and "Cancel" only ever apply to a Session already starting, so
  // both are a deliberate no-op (not an error) for a known Session that isn't starting -- a stale
  // button click racing the wait's own resolution must never surface an error toast. An unknown
  // sessionId is still `notFound`, same as every sibling handler below.
  ipcMain.handle(IPC_REQUESTS.SESSIONS_KEEP_WAITING_FOR_START, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_KEEP_WAITING_FOR_START} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    // getAgent (not getOrCreateAgent): nothing to act on for a Session with no agent this run
    // (it cannot possibly be mid-start), so there is no reason to construct one just to no-op.
    manager.getAgent(sessionId)?.keepWaitingForStart();
    return { ok: true, value: undefined };
  });

  ipcMain.handle(IPC_REQUESTS.SESSIONS_CANCEL_START, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.SESSIONS_CANCEL_START} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    manager.getAgent(sessionId)?.cancelStart();
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
