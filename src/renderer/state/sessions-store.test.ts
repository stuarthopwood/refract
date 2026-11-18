// Issue #509/#510 quality-gate fix (cycle 2, 2026-10-08): regression coverage for the
// openPromises dedup key. `environment: 'node'` has no real `window`, so a minimal
// `window.refract.sessions.open` stub is installed directly on `globalThis` before each call --
// cheap enough that this store never needs a jsdom environment just for this one behaviour.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notify } from './notify';
import { useSessionsStore } from './sessions-store';

vi.mock('./notify', () => ({ notify: vi.fn() }));

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

describe('useSessionsStore.archive', () => {
  function stubArchive(result: unknown) {
    const archive = vi.fn(() => Promise.resolve(result));
    (globalThis as unknown as { window: unknown }).window = { refract: { sessions: { archive } } };
    return archive;
  }

  beforeEach(() => {
    vi.mocked(notify).mockClear();
  });

  it('passes no second argument when the caller gave none, so a plain archive stays one Session', async () => {
    const archive = stubArchive({ ok: true, value: undefined });
    expect(await useSessionsStore.getState().archive('a')).toBe(true);
    expect(archive).toHaveBeenCalledWith('a');
  });

  it('passes includeChildren through when asked for the whole subtree', async () => {
    const archive = stubArchive({ ok: true, value: undefined });
    expect(await useSessionsStore.getState().archive('a', true)).toBe(true);
    expect(archive).toHaveBeenCalledWith('a', true);
  });

  it('notifies and returns false when the archive is refused', async () => {
    const error = { code: 'invalid-argument', message: 'nope' };
    stubArchive({ ok: false, error });
    expect(await useSessionsStore.getState().archive('a', true)).toBe(false);
    expect(notify).toHaveBeenCalledWith(error);
  });
});
