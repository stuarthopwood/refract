// Issue #480 quality-gate fix (test-reviewer, Medium, 2026-10-08): the rename persistence path
// (`updateRepository`) had no test -- unknown id, the id override being ignored, and a round
// trip through disk were all unverified. Scratch files are left in the OS temp folder (never
// removed), the same deliberate choice `terminationDetection.test.ts` already makes under the
// destructive-delete guard.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { RegistryStore, RegistryError } from './registry';
import type { Repository } from '../../shared/model';

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: randomUUID(),
    path: 'C:/repos/pinion',
    name: 'pinion',
    defaultBranch: 'main',
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function freshDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'refract-registry-test-'));
}

describe('RegistryStore.updateRepository', () => {
  it('persists a rename across a re-open', async () => {
    const dir = await freshDir();
    const repository = makeRepository();
    const store = await RegistryStore.open(dir);
    await store.addRepository(repository);
    const updated = await store.updateRepository(repository.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.path).toBe(repository.path);

    const reopened = await RegistryStore.open(dir);
    const persisted = reopened.getRepository(repository.id);
    expect(persisted?.name).toBe('Renamed');
    expect(persisted?.path).toBe(repository.path);
  });

  it('throws not-found for an unknown id', async () => {
    const dir = await freshDir();
    const store = await RegistryStore.open(dir);
    await expect(store.updateRepository('missing-id', { name: 'X' })).rejects.toThrow(RegistryError);
    await expect(store.updateRepository('missing-id', { name: 'X' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('allows two repositories to share the same display name', async () => {
    const dir = await freshDir();
    const a = makeRepository({ path: 'C:/repos/a' });
    const b = makeRepository({ path: 'C:/repos/b' });
    const store = await RegistryStore.open(dir);
    await store.addRepository(a);
    await store.addRepository(b);
    await store.updateRepository(a.id, { name: 'Same name' });
    const updatedB = await store.updateRepository(b.id, { name: 'Same name' });
    expect(updatedB.name).toBe('Same name');
    expect(store.getRepository(a.id)?.name).toBe('Same name');
  });

  it('never touches path or defaultBranch, even if a caller casts past the Pick<Repository, "name"> type', async () => {
    const dir = await freshDir();
    const repository = makeRepository();
    const store = await RegistryStore.open(dir);
    await store.addRepository(repository);
    const patch = { name: 'Renamed', path: 'C:/elsewhere', defaultBranch: 'develop' } as unknown as Pick<Repository, 'name'>;
    const updated = await store.updateRepository(repository.id, patch);
    expect(updated.name).toBe('Renamed');
    expect(updated.path).toBe(repository.path);
    expect(updated.defaultBranch).toBe(repository.defaultBranch);
  });
});
