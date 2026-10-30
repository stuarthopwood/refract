import type { Result } from './ipc';
import type { GitChangesSnapshot } from './model';

/** The `gitChanges.*` IPC contract. */
export interface GitChangesApi {
  list(sessionId: string): Promise<Result<{ snapshot: GitChangesSnapshot | null }>>;
  stage(sessionId: string, paths: string[]): Promise<Result<void>>;
  unstage(sessionId: string, paths: string[]): Promise<Result<void>>;
  stageAll(sessionId: string, group: 'changes' | 'untracked'): Promise<Result<void>>;
  unstageAll(sessionId: string): Promise<Result<void>>;
  diff(sessionId: string, path: string, staged: boolean, untracked: boolean): Promise<Result<{ patch: string; reason: string | null }>>;
  commit(sessionId: string, message: string): Promise<Result<void>>;
  stopWatching(sessionId: string): Promise<Result<void>>;
  ensureWatching(sessionId: string): Promise<Result<void>>;
}
