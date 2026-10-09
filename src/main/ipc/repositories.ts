// IPC handlers for `repositories.*` (contracts/ipc.md "Repositories", tasks.md T021). `remove` is
// refused with `has-sessions` while the Repository still owns any Session, active or archived
// (FR-059), and never touches disk in that case.

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { BranchEntry } from '../../shared/ipc';
import type { Repository, RepositoryRemote, Session } from '../../shared/model';
import { gitRaw, repoInfo } from '../git/git';
import { repositoryRemote } from '../git/remote';
import { defaultBranch, listBranches } from '../git/worktrees';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, mapStoreThrown, notFound } from './util';
import { REPOSITORY_HAS_SESSIONS_MESSAGE } from '../store/registry';
import { MAX_REPOSITORY_NAME_LENGTH } from '../../shared/repositoryName';
import { renameRepositoryCore } from './renameRepository';

/** `repositories.userName` (T072, FR-045): `git config user.name` in the repository's own
 * checkout, falling back to the Windows account name when git has none configured; cached per
 * repository id for the process lifetime so the "Answer:" avatar/name never re-shells out. */
const userNameCache = new Map<string, string>();

async function resolveUserName(repositoryId: string, repoPath: string): Promise<string> {
  const cached = userNameCache.get(repositoryId);
  if (cached !== undefined) return cached;
  const result = await gitRaw(repoPath, ['config', 'user.name']);
  const name = (result.code === 0 ? result.stdout.trim() : '') || os.userInfo().username;
  userNameCache.set(repositoryId, name);
  return name;
}

/** Base branch picker entries (FR-002, contracts/ipc.md `repositories.branches`): the default
 * branch first (when it still exists), then plain branches in git order, then branches owned by
 * one of this repository's Sessions, labelled with that Session's live display name and sorted
 * by it, so a rename shows the next time the picker opens. */
function branchEntries(branches: string[], defaultName: string, sessions: Session[]): BranchEntry[] {
  const owners = new Map(sessions.map((session) => [session.branch, session]));
  const entries: BranchEntry[] = [];
  if (branches.includes(defaultName)) entries.push({ name: defaultName, kind: 'default' });
  const sessionEntries: BranchEntry[] = [];
  for (const name of branches) {
    if (name === defaultName) continue;
    const owner = owners.get(name);
    if (owner) {
      sessionEntries.push({ name, kind: 'session', sessionName: owner.name, archived: owner.archivedAt !== null });
    } else {
      entries.push({ name, kind: 'branch' });
    }
  }
  sessionEntries.sort((a, b) => (a.sessionName ?? '').localeCompare(b.sessionName ?? '', undefined, { sensitivity: 'base' }));
  return [...entries, ...sessionEntries];
}

// Issue #528, gate round 1 fix (Medium, all four reviewers): bounds the remote-detection step
// of `repositories.list()` to about REMOTE_DEADLINE_MS in aggregate, however many repositories
// are registered or however slow one individual `git` call is -- any repository whose own
// check has not settled by the shared deadline keeps the `unknown` placeholder for this
// response (a later `list()` call tries again fresh, each repository's own 70% cost is just one
// `git` spawn now). Concurrency is capped so a large repository count never floods the process
// table with simultaneous `git` spawns.
const REMOTE_CONCURRENCY = 8;
const REMOTE_DEADLINE_MS = 1000;

async function remotesBounded(repositories: Repository[]): Promise<RepositoryRemote[]> {
  const results: RepositoryRemote[] = repositories.map(() => ({ kind: 'unknown' }));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < repositories.length) {
      const i = next++;
      results[i] = await repositoryRemote(repositories[i]!.path);
    }
  }
  const pool = Promise.all(Array.from({ length: Math.min(REMOTE_CONCURRENCY, repositories.length) }, () => worker()));
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, REMOTE_DEADLINE_MS));
  await Promise.race([pool, deadline]);
  return results;
}

export function registerRepositories(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  // Issue #528: `remote` is computed fresh for every response, never read from or written to
  // the registry -- a repository's own remote can change on disk at any time with no Refract
  // action involved.
  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_LIST, async () => {
    const repositories = manager.registry.snapshot().repositories;
    const remotes = await remotesBounded(repositories);
    const withRemote = repositories.map((repository, i) => ({ ...repository, remote: remotes[i]! }));
    return { ok: true, value: withRemote };
  });

  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_ADD, async (_event, repoPath: unknown) => {
    if (typeof repoPath !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.REPOSITORIES_ADD} expects a string path`);
    }
    try {
      const info = await repoInfo(repoPath);
      const branch = await defaultBranch(info.path);
      const repository: Repository = {
        id: randomUUID(),
        path: info.path,
        name: path.basename(info.path),
        defaultBranch: branch,
        addedAt: new Date().toISOString(),
      };
      await manager.registry.addRepository(repository);
      manager.notifyListChanged();
      // Issue #528: a freshly added repository shows the right icon with no refetch needed.
      const remote = await repositoryRemote(repository.path);
      return { ok: true, value: { ...repository, remote } };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_RENAME, async (_event, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.REPOSITORIES_RENAME} expects (id, name) strings`);
    }
    // Quality-gate fix (security-auditor, Low, 2026-10-08): rejected before `trim()` -- Electron's
    // own IPC payload cap already bounds this, so this is defence in depth, not the real guard
    // (that is `validateRepositoryName`'s own length check below, after trimming).
    if (name.length > 4 * MAX_REPOSITORY_NAME_LENGTH) {
      return invalidArgument(`${IPC_REQUESTS.REPOSITORIES_RENAME} name too long`);
    }
    // Quality-gate fix (cycle 3, 2026-10-08): the rest of this handler's own logic (the
    // validate -> resolve -> persist -> notify sequence) now lives in `renameRepositoryCore`
    // (`renameRepository.ts`), injected with this manager's own real dependencies, so it is
    // unit-testable against fakes -- same reasoning as `resumeSessionCore`/`attachSnapshotCore`.
    const result = await renameRepositoryCore(id, name, {
      getRepository: (repositoryId) => manager.registry.getRepository(repositoryId),
      basename: (repositoryPath) => path.basename(repositoryPath),
      updateRepository: (repositoryId, patch) => manager.registry.updateRepository(repositoryId, patch),
      notifyListChanged: () => manager.notifyListChanged(),
    });
    if (!result.ok) return result;
    // Issue #528: the renderer's own `repositories-store.ts` replaces its whole cached Repository
    // with this response (`rename`'s `Promise<string | null>` contract) -- without this, a
    // rename would silently drop the group header's own remote icon back to "unknown" until the
    // next unrelated `repositories.list()` refresh happened to restore it.
    return { ok: true, value: { ...result.value, remote: await repositoryRemote(result.value.path) } };
  });

  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_REMOVE, async (_event, id: unknown) => {
    if (typeof id !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.REPOSITORIES_REMOVE} expects a string id`);
    }
    const hasOwnedSessions = manager.registry.snapshot().sessions.some((s) => s.repositoryId === id);
    if (hasOwnedSessions) {
      return { ok: false, error: { code: 'has-sessions', message: REPOSITORY_HAS_SESSIONS_MESSAGE } };
    }
    try {
      await manager.registry.removeRepository(id);
      manager.notifyListChanged();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_BRANCHES, async (_event, id: unknown) => {
    if (typeof id !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.REPOSITORIES_BRANCHES} expects a string id`);
    }
    const repository = manager.registry.getRepository(id);
    if (!repository) {
      return notFound(`Repository not found: ${id}`);
    }
    try {
      const branches = await listBranches(repository.path);
      const sessions = manager.registry.snapshot().sessions.filter((session) => session.repositoryId === repository.id);
      return { ok: true, value: branchEntries(branches, repository.defaultBranch, sessions) };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_PICK_FOLDER, async () => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    const value = result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
    return { ok: true, value };
  });

  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_USER_NAME, async (_event, id: unknown) => {
    if (typeof id !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.REPOSITORIES_USER_NAME} expects a string id`);
    }
    const repository = manager.registry.getRepository(id);
    if (!repository) {
      return notFound(`Repository not found: ${id}`);
    }
    return { ok: true, value: await resolveUserName(repository.id, repository.path) };
  });
}
