// Issue #509/#510 quality-gate fix (cycle 2, 2026-10-08): regression coverage for the
// openPromises dedup key. `environment: 'node'` has no real `window`, so a minimal
// `window.refract.sessions.open` stub is installed directly on `globalThis` before each call --
// cheap enough that this store never needs a jsdom environment just for this one behaviour.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionsStore } from './sessions-store';

describe('useSessionsStore.open', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], openingIds: new Set() });
  });

  it('does not let a concurrent forced (userAction: true) call join an in-flight passive one', async () => {
    let resolvePassive!: (value: unknown) => void;
    const passivePromise = new Promise((resolve) => {
      resolvePassive = resolve;
    });
    const calls: Array<[string, boolean | undefined]> = [];
    (globalThis as unknown as { window: unknown }).window = {
      refract: {
        sessions: {
          open: vi.fn((id: string, userAction?: boolean) => {
            calls.push([id, userAction]);
            if (userAction === true) {
              return Promise.resolve({ ok: true, value: { runtime: { status: 'idle' } } });
            }
            return passivePromise;
          }),
        },
      },
    };

    const passiveResultPromise = useSessionsStore.getState().open('session-1');
    const forcedResult = await useSessionsStore.getState().open('session-1', true);

    // Both calls reached the real IPC bridge with their OWN argument -- the forced call was
    // never silently handed the passive call's (still in-flight, still-stopped-shaped) promise.
    expect(calls).toEqual([
      ['session-1', undefined],
      ['session-1', true],
    ]);
    expect((forcedResult as { runtime: { status: string } } | null)?.runtime.status).toBe('idle');

    resolvePassive({ ok: true, value: { runtime: { status: 'stopped' } } });
    await passiveResultPromise;
  });

  it('still joins two concurrent passive calls for the same id into one request', async () => {
    let resolveCall!: (value: unknown) => void;
    const shared = new Promise((resolve) => {
      resolveCall = resolve;
    });
    const open = vi.fn(() => shared);
    (globalThis as unknown as { window: unknown }).window = { refract: { sessions: { open } } };

    const first = useSessionsStore.getState().open('session-1');
    const second = useSessionsStore.getState().open('session-1');
    expect(open).toHaveBeenCalledTimes(1);

    resolveCall({ ok: true, value: { runtime: { status: 'idle' } } });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });
});
