// IPC handlers for `repositories.*` (contracts/ipc.md "Repositories", tasks.md T021). `remove` is
// refused with `session-running` while any of the Repository's Sessions has a live agent, and
// never touches disk in that case.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { BranchEntry } from '../../shared/ipc';
import type { Repository, Session } from '../../shared/model';
import { repoInfo } from '../git/git';
import { defaultBranch, listBranches } from '../git/worktrees';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, mapStoreThrown, notFound } from './util';

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

export function registerRepositories(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_LIST, async () => ({ ok: true, value: manager.registry.snapshot().repositories }));

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
      return { ok: true, value: repository };
    } catch (err) {
      return mapStoreThrown(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.REPOSITORIES_REMOVE, async (_event, id: unknown) => {
    if (typeof id !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.REPOSITORIES_REMOVE} expects a string id`);
    }
    const running = manager.summaries().some((s) => s.repositoryId === id && s.status !== 'stopped');
    if (running) {
      return { ok: false, error: { code: 'session-running', message: 'A Session in this repository is still running.' } };
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
}
