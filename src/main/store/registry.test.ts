// Issue #480 quality-gate fix (test-reviewer, Medium, 2026-10-08): the rename persistence path
// (`updateRepository`) had no test -- unknown id, the id override being ignored, and a round
// trip through disk were all unverified.
// Issue #510 quality-gate fix (cycle 5, 2026-10-08): regression coverage for the
// rollback-on-failed-write behaviour `RegistryStore.updateSession` gained in cycle 4 -- added
// alongside the persisted stoppedOnRequest marker (`stoppedOnRequestMarker.ts`'s own
// `recordStoppedOnRequestMarker`/`clearStoppedOnRequestMarker`, both of which call this), but
// never itself had a test on this branch.
// Scratch files from both suites are left in the OS temp folder (never removed), the same
// deliberate choice `terminationDetection.test.ts` already makes under the destructive-delete
// guard.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { RegistryStore, RegistryError } from './registry';
import { writeJsonFile } from './atomicJson';
import type { Repository, Session } from '../../shared/model';

// Quality-gate fix (cycle 3, 2026-10-08, test-reviewer, Medium): the rollback-on-failed-write
// tests below need a write that genuinely rejects -- `writeJsonFile` itself auto-creates its
// own containing directory (`fs.mkdir(..., { recursive: true })`), so deleting the temp dir out
// from under it would NOT force a failure, it would just get silently recreated. Spied, not a
// full module replacement: every other test in this file still exercises the real atomic
// write/rename/reopen round trip.
vi.mock('./atomicJson', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomicJson')>();
  return { ...actual, writeJsonFile: vi.fn(actual.writeJsonFile) };
});

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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    repositoryId: 'repo-1',
    name: 'Test Session',
    branch: 'swift-otter',
    baseBranch: 'main',
    worktreePath: 'C:/worktrees/swift-otter',
    sessionDir: 'C:/sessions/swift-otter',
    currentConversation: 'C:/sessions/swift-otter/conv.jsonl',
    lastMessageCount: 10,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

async function freshDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'refract-registry-test-'));
}

async function freshRegistry(): Promise<{ dir: string; registry: RegistryStore }> {
  const dir = await freshDir();
  const registry = await RegistryStore.open(dir);
  await registry.addRepository({ id: 'repo-1', path: 'C:/repos/x', name: 'x', defaultBranch: 'main', addedAt: new Date().toISOString() });
  return { dir, registry };
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

  // Quality-gate fix (cycle 3, 2026-10-08, test-reviewer, Medium): the rollback-on-failed-write
  // branch (memory must not keep a name the disk copy never got) had no test.
  it('rolls back the in-memory name when the write fails, rejecting with the real error', async () => {
    const dir = await freshDir();
    const repository = makeRepository();
    const store = await RegistryStore.open(dir);
    await store.addRepository(repository);
    vi.mocked(writeJsonFile).mockRejectedValueOnce(new Error('disk full'));

    await expect(store.updateRepository(repository.id, { name: 'Should not stick' })).rejects.toThrow('disk full');
    expect(store.getRepository(repository.id)?.name).toBe(repository.name);
  });

  // Quality-gate fix (cycle 3, 2026-10-08, security-auditor, Low): the rollback must only ever
  // restore the name from BEFORE THIS call's own write -- never clobber a second call that
  // started while this one's write was still in flight, synchronously overwrote the same entry
  // with its OWN next value, and then itself completed and persisted successfully before this
  // (slower) call's write rejects and its rollback runs.
  it('does not clobber a second call that already won the race, when this one is slower and fails', async () => {
    const dir = await freshDir();
    const repository = makeRepository();
    const store = await RegistryStore.open(dir);
    await store.addRepository(repository);

    let rejectSlow!: (err: Error) => void;
    const slowWrite = new Promise<void>((_resolve, reject) => {
      rejectSlow = reject;
    });
    // Only THIS first call's write is swapped out -- the second call below falls through to the
    // mock's own default implementation (the real `writeJsonFile`, wired in by `vi.mock` above).
    vi.mocked(writeJsonFile).mockImplementationOnce(() => slowWrite);

    const slowCall = store.updateRepository(repository.id, { name: 'Slow, fails' });
    // Synchronously-run portion of `slowCall` above has already overwritten the in-memory entry
    // with 'Slow, fails' and is now awaiting `slowWrite` -- exactly the window the old,
    // unconditional rollback was vulnerable in.
    await store.updateRepository(repository.id, { name: 'Fast, wins' });
    rejectSlow(new Error('disk full'));

    await expect(slowCall).rejects.toThrow('disk full');
    expect(store.getRepository(repository.id)?.name).toBe('Fast, wins');
  });

  // Quality-gate fix (cycle 5, 2026-10-08, test-reviewer, Medium): the test above uses two
  // DIFFERENT names, which a value-compare rollback (`?.name === next.name`) would ALSO happen
  // to get right by coincidence (the fast call's name never matches the slow call's own patch
  // value). The real gap only shows with the SAME name on both calls: a value-compare rollback
  // would then match the fast call's entry by name and put back the name from before EITHER
  // call, even though the fast call already reported success and persisted its own write.
  // Identity (`=== next`), not value, is what actually closes it.
  it('does not clobber a second call to the SAME name, when the first is slower and fails', async () => {
    const dir = await freshDir();
    const repository = makeRepository();
    const store = await RegistryStore.open(dir);
    await store.addRepository(repository);

    let rejectSlow!: (err: Error) => void;
    const slowWrite = new Promise<void>((_resolve, reject) => {
      rejectSlow = reject;
    });
    vi.mocked(writeJsonFile).mockImplementationOnce(() => slowWrite);

    const slowCall = store.updateRepository(repository.id, { name: 'Same name' });
    await store.updateRepository(repository.id, { name: 'Same name' });
    rejectSlow(new Error('disk full'));

    await expect(slowCall).rejects.toThrow('disk full');
    expect(store.getRepository(repository.id)?.name).toBe('Same name');
    const reopened = await RegistryStore.open(dir);
    expect(reopened.getRepository(repository.id)?.name).toBe('Same name');
  });
});

describe('RegistryStore.updateSession rollback on a failed write', () => {
  it('restores the previous fields in memory and rejects with the real error', async () => {
    const { registry } = await freshRegistry();
    const session = makeSession({ stoppedOnRequestConversation: null, stoppedOnRequestAtSize: null });
    await registry.addSession(session);
    vi.mocked(writeJsonFile).mockRejectedValueOnce(new Error('disk full'));

    await expect(
      registry.updateSession(session.id, { stoppedOnRequestConversation: session.currentConversation, stoppedOnRequestAtSize: 42 }),
    ).rejects.toThrow('disk full');

    const current = registry.getSession(session.id);
    expect(current?.stoppedOnRequestConversation).toBeNull();
    expect(current?.stoppedOnRequestAtSize).toBeNull();
  });

  it('does not clobber a second, already-persisted call for the same Session when a slower call fails late', async () => {
    const { registry } = await freshRegistry();
    const session = makeSession({ stoppedOnRequestConversation: null, stoppedOnRequestAtSize: null });
    await registry.addSession(session);

    let rejectSlow!: (err: Error) => void;
    const slowWrite = new Promise<void>((_resolve, reject) => {
      rejectSlow = reject;
    });
    vi.mocked(writeJsonFile).mockImplementationOnce(() => slowWrite);

    const slowCall = registry.updateSession(session.id, { stoppedOnRequestConversation: 'C:/slow.jsonl', stoppedOnRequestAtSize: 1 });
    // The slow call's own synchronous portion has already overwritten the in-memory entry with
    // its own patch and is now awaiting `slowWrite` -- exactly the window the rollback's
    // reference-equality check (not a field compare) has to survive.
    await registry.updateSession(session.id, { stoppedOnRequestConversation: 'C:/fast.jsonl', stoppedOnRequestAtSize: 2 });
    rejectSlow(new Error('disk full'));

    await expect(slowCall).rejects.toThrow('disk full');
    expect(registry.getSession(session.id)?.stoppedOnRequestConversation).toBe('C:/fast.jsonl');
  });

  it('a reopened store does not contain the failed patch', async () => {
    const { dir, registry } = await freshRegistry();
    const session = makeSession({ stoppedOnRequestConversation: null, stoppedOnRequestAtSize: null });
    await registry.addSession(session);
    vi.mocked(writeJsonFile).mockRejectedValueOnce(new Error('disk full'));

    await expect(
      registry.updateSession(session.id, { stoppedOnRequestConversation: session.currentConversation, stoppedOnRequestAtSize: 42 }),
    ).rejects.toThrow('disk full');

    const reopened = await RegistryStore.open(dir);
    const persisted = reopened.getSession(session.id);
    expect(persisted?.stoppedOnRequestConversation).toBeNull();
    expect(persisted?.stoppedOnRequestAtSize).toBeNull();
  });
});
