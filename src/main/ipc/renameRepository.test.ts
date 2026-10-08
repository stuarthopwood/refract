// Issue #480 quality-gate fix (cycle 3, 2026-10-08): regression coverage for
// renameRepositoryCore against injected fakes -- repositoryName.test.ts only ever proved the
// pure validateRepositoryName/resolveRepositoryName functions work, never that this HANDLER
// actually trims before validating, resolves an empty/joiner-only name to the folder's own
// basename, maps a registry-thrown error, or notifies the list on success.
import { describe, it, expect, vi } from 'vitest';
import { renameRepositoryCore } from './renameRepository';
import type { RenameRepositoryDeps } from './renameRepository';
import type { Repository } from '../../shared/model';
import { RegistryError } from '../store/registry';

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'repo-1',
    path: 'C:/repos/pinion',
    name: 'pinion',
    defaultBranch: 'main',
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RenameRepositoryDeps> = {}): RenameRepositoryDeps {
  const repository = makeRepository();
  return {
    getRepository: () => repository,
    basename: (p) => p.split('/').pop()!,
    updateRepository: async (id, patch) => ({ ...repository, ...patch }),
    notifyListChanged: () => {},
    ...overrides,
  };
}

describe('renameRepositoryCore', () => {
  it('returns not-found for an unknown repository id', async () => {
    const deps = makeDeps({ getRepository: () => undefined });
    const result = await renameRepositoryCore('missing', 'New name', deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('trims surrounding whitespace before persisting', async () => {
    const updateRepository = vi.fn(async (id: string, patch: { name: string }) => ({ ...makeRepository(), ...patch }));
    const result = await renameRepositoryCore('repo-1', '  Trimmed  ', makeDeps({ updateRepository }));
    expect(result.ok).toBe(true);
    expect(updateRepository).toHaveBeenCalledWith('repo-1', { name: 'Trimmed' });
  });

  // Point 4 (#480): clearing the field and committing resets to the folder's own basename.
  it('resolves an empty (post-trim) name to the folder basename, not an error', async () => {
    const updateRepository = vi.fn(async (id: string, patch: { name: string }) => ({ ...makeRepository(), ...patch }));
    const result = await renameRepositoryCore('repo-1', '   ', makeDeps({ basename: () => 'pinion', updateRepository }));
    expect(result.ok).toBe(true);
    expect(updateRepository).toHaveBeenCalledWith('repo-1', { name: 'pinion' });
  });

  it('rejects an over-length name with an unprefixed, inline-safe message', async () => {
    const result = await renameRepositoryCore('repo-1', 'x'.repeat(61), makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/too long/);
      expect(result.error.message).not.toMatch(/repositories\.rename/);
    }
  });

  it('rejects control characters without ever calling updateRepository', async () => {
    const updateRepository = vi.fn();
    const result = await renameRepositoryCore('repo-1', 'bad\u0007name', makeDeps({ updateRepository }));
    expect(result.ok).toBe(false);
    expect(updateRepository).not.toHaveBeenCalled();
  });

  it('notifies the list and returns the updated repository on success', async () => {
    const notifyListChanged = vi.fn();
    const updated = makeRepository({ name: 'Renamed' });
    const result = await renameRepositoryCore('repo-1', 'Renamed', makeDeps({ updateRepository: async () => updated, notifyListChanged }));
    expect(result).toEqual({ ok: true, value: updated });
    expect(notifyListChanged).toHaveBeenCalledTimes(1);
  });

  it('maps a thrown registry error instead of letting it propagate, and never notifies', async () => {
    const notifyListChanged = vi.fn();
    const updateRepository = async () => { throw new RegistryError('not-found', 'Repository not found: repo-1'); };
    const result = await renameRepositoryCore('repo-1', 'Renamed', makeDeps({ updateRepository, notifyListChanged }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    expect(notifyListChanged).not.toHaveBeenCalled();
  });
});
