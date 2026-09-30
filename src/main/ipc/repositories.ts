// IPC handlers for `repositories.*` (contracts/ipc.md "Repositories", tasks.md T021). `remove` is
// refused with `session-running` while any of the Repository's Sessions has a live agent, and
// never touches disk in that case.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { Repository } from '../../shared/model';
import { GitError, repoInfo } from '../git/git';
import { defaultBranch, listBranches } from '../git/worktrees';
import { RegistryError } from '../store/registry';
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
      return mapThrown(err);
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
      return mapThrown(err);
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
      return { ok: true, value: { branches, default: repository.defaultBranch } };
    } catch (err) {
      return mapThrown(err);
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
