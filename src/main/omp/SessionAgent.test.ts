// Issue #510 quality-gate fix (HIGH, cycle 5, 2026-10-08): regression coverage for the
// marker-write-must-be-awaited-before-quit bug -- `onExit`'s requested branch used to fire
// `recordStoppedOnRequestMarker` with `void`, and `shutdown()` never waited for it, so quitting
// Refract while a Session was mid-tool-call could exit before the marker reached disk (exactly
// the restart case cycle 4 was meant to protect). `SessionAgent` has no other test file and no
// dependency-injection seam for a real `OmpProcess`, so this drives the exact PRIVATE `onExit`
// method directly (`as unknown as` cast -- the only seam available) against a REAL RegistryStore,
// the same technique `SessionManager.test.ts` already established for this class's private state.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../../shared/model';
import type { SettingsStore } from '../store/settings';

vi.mock('./stoppedOnRequestMarker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stoppedOnRequestMarker')>();
  return { ...actual, recordStoppedOnRequestMarker: vi.fn(actual.recordStoppedOnRequestMarker) };
});

import { SessionAgent } from './SessionAgent';
import { RegistryStore } from '../store/registry';
import { recordStoppedOnRequestMarker } from './stoppedOnRequestMarker';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    repositoryId: 'repo-1',
    name: 'Test Session',
    branch: 'swift-otter',
    baseBranch: 'main',
    worktreePath: os.tmpdir(),
    sessionDir: 'C:/sessions/swift-otter',
    currentConversation: null,
    lastMessageCount: 10,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

function fakeSettings(): SettingsStore {
  return { get: () => ({ approvalMode: 'ask' }) } as unknown as SettingsStore;
}

async function makeAgentAndRegistry(session: Session): Promise<{ dir: string; registry: RegistryStore; agent: SessionAgent }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refract-session-agent-test-'));
  const registry = await RegistryStore.open(dir);
  await registry.addRepository({ id: session.repositoryId, path: 'C:/repos/x', name: 'x', defaultBranch: 'main', addedAt: new Date().toISOString() });
  await registry.addSession(session);
  const agent = new SessionAgent({
    sessionId: session.id,
    registry,
    settings: fakeSettings(),
    isVisible: () => false,
    isWindowFocused: () => true,
  });
  return { dir, registry, agent };
}

/** Quality-gate fix (cycle 6, 2026-10-08, test-reviewer, Medium): counting a fixed number of
 * microtask ticks is fragile -- without the fix, `shutdown()` happens to settle within about
 * 2-3 ticks today, but one more `await` added anywhere in that chain tomorrow would make the
 * pre-fix code settle AFTER this many ticks too, and the assertion would pass for the wrong
 * reason. `setImmediate` flushes the ENTIRE microtask queue before each check (a macrotask
 * boundary), so this holds regardless of how many microtask hops `shutdown()`'s own call chain
 * happens to take -- the write is still gated either way, so only the real fix keeps
 * `shutdownResolved` false across it. */
function flushMicrotasks(times = 2): Promise<void> {
  return times <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setImmediate(() => flushMicrotasks(times - 1).then(resolve)));
}

describe('SessionAgent.shutdown waits for a pending stoppedOnRequest marker write', () => {
  it('does not resolve until the marker write settles, then the marker is on disk', async () => {
    const conversation = path.join(os.tmpdir(), `refract-agent-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const session = makeSession({ currentConversation: conversation });
    const { dir, registry, agent } = await makeAgentAndRegistry(session);

    // Gates the real `recordStoppedOnRequestMarker` behind a promise this test controls, so the
    // assertion below is a genuine timing proof, not a race that happens to pass because the
    // write is fast on a real filesystem.
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.mocked(recordStoppedOnRequestMarker).mockImplementationOnce(async (...args) => {
      await gate;
      return (await vi.importActual<typeof import('./stoppedOnRequestMarker')>('./stoppedOnRequestMarker')).recordStoppedOnRequestMarker(...args);
    });

    // Simulates a real GENUINE shutdown (`this.stopRequested` set first, matching what the real
    // public `shutdown()` call below does on its very first line, which is exactly the signal
    // `onExit`'s own cycle-6 `stopRequested` guard now requires before treating an exit as
    // user-requested): `onExit` is private, there is no public seam and no injectable
    // `OmpProcess`, so this calls it directly -- the only way to exercise the exact production
    // code path (`this.markerWrite = recordStoppedOnRequestMarker(...)`) without building a full
    // fake OMP handshake for a single two-line fix.
    (agent as unknown as { process: unknown; stopRequested: boolean }).process = { stop: async () => undefined };
    (agent as unknown as { stopRequested: boolean }).stopRequested = true;
    await (agent as unknown as { onExit: (info: { code: number | null; requested: boolean }) => Promise<void> }).onExit({
      code: null,
      requested: true,
    });
    // `onExit` itself never awaits the marker write (fire-and-forget by design -- `shutdown()` is
    // what must wait), so it has already returned with the write still gated.

    let shutdownResolved = false;
    const shutdownPromise = agent.shutdown().then(() => {
      shutdownResolved = true;
    });

    // Flushes every microtask queued so far, repeatedly, across several macrotask boundaries;
    // `shutdown()` must still be waiting on the gated marker write at this point regardless.
    await flushMicrotasks(5);
    expect(shutdownResolved).toBe(false);

    releaseWrite();
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);

    const expectedSize = (await fs.stat(conversation)).size;
    const reopened = await RegistryStore.open(dir);
    const persisted = reopened.getSession(session.id);
    expect(persisted?.stoppedOnRequestConversation).toBe(conversation);
    expect(persisted?.stoppedOnRequestAtSize).toBe(expectedSize);
  });
});

// Quality-gate fix (HIGH, cycle 6, 2026-10-08): `info.requested` reflects only `OmpProcess`'s
// own internal flag, set unconditionally by `OmpProcess.stop()` -- which `launch()`'s own
// failed-handshake (`proc.start()` rejects) and failed-attach (`attachAndVerify` throws) cleanup
// paths BOTH also call, for a process the user never asked to stop at all. Before this fix,
// `onExit` could not tell that apart from a genuine `shutdown()`, and recorded the launch
// failure as a deliberate stop: `stoppedOnRequest` set true, the persisted marker written,
// `terminatedUnexpectedly: false` emitted -- hiding the exact crash evidence `recordStartFailure`
// (called right after, by `launch()`'s own catch block) was about to report, and outliving even
// an app restart via the marker. Both real-world triggers (a rejected `proc.start()` and a
// thrown `attachAndVerify`) converge on the identical `onExit({ requested: true })` call with
// `this.stopRequested` still at its default `false` -- there is nothing in `onExit`'s own logic
// that distinguishes which one caused it, so one direct invocation (the same technique the
// describe block above uses, the only seam available) proves the fix for both.
describe("SessionAgent.onExit does not treat launch()'s own failure cleanup as a requested stop", () => {
  it('leaves stoppedOnRequest false and writes no marker when proc.start() rejects (simulated via its stop() cleanup)', async () => {
    const conversation = path.join(os.tmpdir(), `refract-agent-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const session = makeSession({ currentConversation: conversation });
    const { dir, registry, agent } = await makeAgentAndRegistry(session);

    // `launch()`'s own `catch` block for a rejected `proc.start()` calls `await proc.stop()`
    // before `recordStartFailure` -- `this.stopRequested` is left at its default `false`,
    // because nothing here is `shutdown()`.
    (agent as unknown as { process: unknown }).process = { stop: async () => undefined };
    await (agent as unknown as { onExit: (info: { code: number | null; requested: boolean }) => Promise<void> }).onExit({
      code: null,
      requested: true,
    });

    expect(agent.runtimeSnapshot.stoppedOnRequest).toBe(false);
    expect(recordStoppedOnRequestMarker).not.toHaveBeenCalled();
    const persisted = registry.getSession(session.id);
    expect(persisted?.stoppedOnRequestConversation).toBeUndefined();
    const reopened = await RegistryStore.open(dir);
    expect(reopened.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
  });

  it('leaves stoppedOnRequest false and writes no marker when attachAndVerify throws (simulated via its own stop() cleanup)', async () => {
    const conversation = path.join(os.tmpdir(), `refract-agent-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const session = makeSession({ currentConversation: conversation });
    const { registry, agent } = await makeAgentAndRegistry(session);

    // `launch()`'s own `catch` block for a thrown `attachAndVerify` ALSO calls `await proc.stop()`
    // before `recordStartFailure`, and also never sets `this.stopRequested` -- the exact same
    // `onExit` inputs as the `proc.start()` rejection above, since `onExit` itself cannot (and
    // must not need to) distinguish which launch step failed.
    (agent as unknown as { process: unknown }).process = { stop: async () => undefined };
    await (agent as unknown as { onExit: (info: { code: number | null; requested: boolean }) => Promise<void> }).onExit({
      code: null,
      requested: true,
    });

    expect(agent.runtimeSnapshot.stoppedOnRequest).toBe(false);
    expect(recordStoppedOnRequestMarker).not.toHaveBeenCalled();
    expect(registry.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
  });
});
