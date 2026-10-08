// Issue #480 quality-gate fix (cycle 3, 2026-10-08): the REPOSITORIES_RENAME handler's own body,
// pulled out so the validate -> resolve -> persist -> notify sequence is unit-testable against
// injected fakes -- same reasoning, and the same shape, as `resumeSessionCore`/`attachSnapshotCore`.
// `repositoryName.test.ts` only ever proved the pure `validateRepositoryName`/`resolveRepositoryName`
// functions work, never that this HANDLER actually wires them together (trims before validating,
// resolves an empty/joiner-only name to the folder's own basename, maps a registry-thrown error,
// or notifies the list on success).
import type { Result } from '../../shared/ipc';
import type { Repository } from '../../shared/model';
import { resolveRepositoryName, validateRepositoryName } from '../../shared/repositoryName';
import { invalidArgument, mapStoreThrown, notFound } from './util';

export interface RenameRepositoryDeps {
  getRepository(id: string): Repository | undefined;
  basename(repositoryPath: string): string;
  updateRepository(id: string, patch: { name: string }): Promise<Repository>;
  notifyListChanged(): void;
}

export async function renameRepositoryCore(id: string, name: string, deps: RenameRepositoryDeps): Promise<Result<Repository>> {
  const repository = deps.getRepository(id);
  if (!repository) return notFound(`Repository not found: ${id}`);
  const trimmed = name.trim();
  const validationError = validateRepositoryName(trimmed);
  // Quality-gate fix (cycle 2, 2026-10-08): no channel-name prefix here -- this exact string is
  // shown inline in the rename field's own `role="alert"` text (`SessionList.tsx`), never a
  // toast, so a user must never see "repositories.rename name too long (max 60 characters)".
  if (validationError) return invalidArgument(validationError);
  const nextName = resolveRepositoryName(trimmed, deps.basename(repository.path));
  try {
    const updated = await deps.updateRepository(id, { name: nextName });
    deps.notifyListChanged();
    return { ok: true, value: updated };
  } catch (err) {
    return mapStoreThrown(err);
  }
}
