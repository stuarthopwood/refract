// Issue #455 quality-gate remediation (test-reviewer MEDIUM: "there is precedent for store tests
// (sessions-store.test.ts), but none were added"). `environment: 'node'` has no real `window`, so
// a minimal `window.refract.modelRoles` stub is installed directly on `globalThis` before each
// test, the same pattern `sessions-store.test.ts` already uses.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useModelRolesStore } from './model-roles-store';

function stubRefract(modelRoles: Record<string, unknown>) {
  (globalThis as unknown as { window: unknown }).window = { refract: { modelRoles } };
}

beforeEach(() => {
  useModelRolesStore.setState({
    roles: {},
    loaded: false,
    loadError: null,
    pendingRoles: new Set(),
    saveErrors: {},
    overrideNotes: {},
    catalogs: {},
    catalogErrors: {},
  });
});

describe('useModelRolesStore.load', () => {
  it('applies a successful read when nothing is pending', async () => {
    stubRefract({ list: vi.fn(async () => ({ ok: true, value: { task: 'anthropic/claude-sonnet-4-5' } })) });
    await useModelRolesStore.getState().load();
    expect(useModelRolesStore.getState().roles).toEqual({ task: 'anthropic/claude-sonnet-4-5' });
    expect(useModelRolesStore.getState().loaded).toBe(true);
    expect(useModelRolesStore.getState().loadError).toBeNull();
  });

  it('sets loadError on a failed read, and marks loaded true regardless', async () => {
    stubRefract({ list: vi.fn(async () => ({ ok: false, error: { code: 'omp-probe-failed', message: 'omp not found' } })) });
    await useModelRolesStore.getState().load();
    expect(useModelRolesStore.getState().loadError).toBe('omp not found');
    expect(useModelRolesStore.getState().loaded).toBe(true);
  });

  it('never clobbers roles with a stale read while a setRole write is still pending', async () => {
    useModelRolesStore.setState({ pendingRoles: new Set(['task']) });
    useModelRolesStore.setState({ roles: { smol: 'openai/gpt-4.1-mini' } });
    stubRefract({ list: vi.fn(async () => ({ ok: true, value: { task: 'should-not-apply' } })) });
    await useModelRolesStore.getState().load();
    // The stale read's roles value was discarded; the role the user is mid-save on was not reverted.
    expect(useModelRolesStore.getState().roles).toEqual({ smol: 'openai/gpt-4.1-mini' });
    expect(useModelRolesStore.getState().loaded).toBe(true);
  });

  it('keepError:true leaves loaded/loadError cached while the retry is in flight, then clears loadError on success', async () => {
    useModelRolesStore.setState({ loaded: true, loadError: 'first failure' });
    let resolveRetry!: (value: unknown) => void;
    const retryPromise = new Promise((resolve) => {
      resolveRetry = resolve;
    });
    stubRefract({ list: vi.fn(() => retryPromise) });

    const loadPromise = useModelRolesStore.getState().load({ keepError: true });
    // Quality-gate remediation (gate cycle 3 HIGH): a retry must not reset to the loading state
    // up front -- the section keeps the failed-load Alert and its Retry button mounted while
    // this is in flight, the same way `loadCatalog`'s own forced retry already behaves.
    expect(useModelRolesStore.getState().loaded).toBe(true);
    expect(useModelRolesStore.getState().loadError).toBe('first failure');

    resolveRetry({ ok: true, value: { task: 'anthropic/claude-sonnet-4-5' } });
    await loadPromise;
    expect(useModelRolesStore.getState().loadError).toBeNull();
    expect(useModelRolesStore.getState().loaded).toBe(true);
    expect(useModelRolesStore.getState().roles).toEqual({ task: 'anthropic/claude-sonnet-4-5' });
  });

  it('a failing keepError:true retry keeps loaded/loadError cached in flight, then replaces loadError with the new message', async () => {
    useModelRolesStore.setState({ loaded: true, loadError: 'first failure' });
    let resolveRetry!: (value: unknown) => void;
    const retryPromise = new Promise((resolve) => {
      resolveRetry = resolve;
    });
    stubRefract({ list: vi.fn(() => retryPromise) });

    const loadPromise = useModelRolesStore.getState().load({ keepError: true });
    // Test-reviewer LOW: this test previously asserted only the FINAL state, which is identical
    // whether or not `keepError` actually did anything -- checking the state WHILE the retry is
    // still in flight is what proves `keepError` is the reason the old message survives.
    expect(useModelRolesStore.getState().loaded).toBe(true);
    expect(useModelRolesStore.getState().loadError).toBe('first failure');

    resolveRetry({ ok: false, error: { code: 'omp-probe-failed', message: 'second failure' } });
    await loadPromise;
    expect(useModelRolesStore.getState().loaded).toBe(true);
    expect(useModelRolesStore.getState().loadError).toBe('second failure');
  });

  it('load() WITHOUT keepError resets to the loading state while in flight, discarding a stale error', async () => {
    useModelRolesStore.setState({ loaded: true, loadError: 'x' });
    let resolveFirst!: (value: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    stubRefract({ list: vi.fn(() => firstPromise) });

    const loadPromise = useModelRolesStore.getState().load();
    // Test-reviewer LOW: pins the default (no `keepError`) reset itself, which nothing else in
    // this file directly asserted -- deleting the reset in the store would still pass every
    // other test here.
    expect(useModelRolesStore.getState().loaded).toBe(false);
    expect(useModelRolesStore.getState().loadError).toBeNull();

    resolveFirst({ ok: true, value: {} });
    await loadPromise;
  });

  it('a successful keepError:true retry clears a stale loadError even while a setRole write is still pending', async () => {
    // Code-reviewer MEDIUM (gate cycle 4): the pending-write branch used to set only
    // `{ loaded: true }`, so a stale `loadError` from an earlier failure survived a retry that
    // actually succeeded, and the section kept showing "Could not read model roles" forever.
    useModelRolesStore.setState({ loaded: true, loadError: 'x', pendingRoles: new Set(['task']) });
    stubRefract({ list: vi.fn(async () => ({ ok: true, value: { task: 'should-not-apply-either' } })) });
    await useModelRolesStore.getState().load({ keepError: true });
    expect(useModelRolesStore.getState().loadError).toBeNull();
    expect(useModelRolesStore.getState().loaded).toBe(true);
    // The pending-write guard (separately tested above) still applies: roles themselves are
    // untouched by this read while the write is in flight.
    expect(useModelRolesStore.getState().roles).toEqual({});
  });

  it('returns the same in-flight promise to a second call made before the first resolves, and only calls list() once', async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const list = vi.fn(() => firstPromise);
    stubRefract({ list });

    const first = useModelRolesStore.getState().load();
    const second = useModelRolesStore.getState().load();
    expect(first).toBe(second);

    resolveFirst({ ok: true, value: {} });
    await first;
    await second;
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('useModelRolesStore.setRole', () => {
  it('clears a previous saveError on a successful save', async () => {
    useModelRolesStore.setState({ saveErrors: { task: 'previous failure' } });
    stubRefract({ set: vi.fn(async () => ({ ok: true, value: { roles: { task: 'anthropic/claude-sonnet-4-5' } } })) });
    const result = await useModelRolesStore.getState().setRole('task', 'anthropic/claude-sonnet-4-5');
    expect(result).toEqual({ ok: true });
    expect(useModelRolesStore.getState().saveErrors.task).toBeUndefined();
    expect(useModelRolesStore.getState().roles).toEqual({ task: 'anthropic/claude-sonnet-4-5' });
  });

  it('sets a saveError on a failed save and leaves roles untouched', async () => {
    useModelRolesStore.setState({ roles: { task: 'anthropic/claude-sonnet-4-5' } });
    stubRefract({ set: vi.fn(async () => ({ ok: false, error: { code: 'invalid-argument', message: 'Model selector cannot be blank.' } })) });
    const result = await useModelRolesStore.getState().setRole('task', '');
    expect(result).toEqual({ ok: false, message: 'Model selector cannot be blank.' });
    expect(useModelRolesStore.getState().saveErrors.task).toBe('Model selector cannot be blank.');
    expect(useModelRolesStore.getState().roles).toEqual({ task: 'anthropic/claude-sonnet-4-5' });
  });

  it('records an overrideNote when overriddenBy is present, and clears it on a later save without one', async () => {
    stubRefract({ set: vi.fn(async () => ({ ok: true, value: { roles: { task: 'x' }, overriddenBy: 'project' } })) });
    await useModelRolesStore.getState().setRole('task', 'x');
    expect(useModelRolesStore.getState().overrideNotes.task).toBe('project');

    stubRefract({ set: vi.fn(async () => ({ ok: true, value: { roles: { task: 'y' } } })) });
    await useModelRolesStore.getState().setRole('task', 'y');
    expect(useModelRolesStore.getState().overrideNotes.task).toBeUndefined();
  });

  it('clears pendingRoles for the role regardless of outcome', async () => {
    stubRefract({ set: vi.fn(async () => ({ ok: false, error: { code: 'omp-probe-failed', message: 'boom' } })) });
    await useModelRolesStore.getState().setRole('task', 'x');
    expect(useModelRolesStore.getState().pendingRoles.has('task')).toBe(false);
  });
});

describe('useModelRolesStore.loadCatalog', () => {
  it('fetches once and caches; a second non-forced call does not re-fetch', async () => {
    const listCatalog = vi.fn(async () => ({ ok: true, value: [] }));
    stubRefract({ listCatalog });
    await useModelRolesStore.getState().loadCatalog('chat');
    await useModelRolesStore.getState().loadCatalog('chat');
    expect(listCatalog).toHaveBeenCalledTimes(1);
  });

  it('a cached ERROR also short-circuits a non-forced call', async () => {
    const listCatalog = vi.fn(async () => ({ ok: false, error: { code: 'omp-probe-failed', message: 'omp not found' } }));
    stubRefract({ listCatalog });
    await useModelRolesStore.getState().loadCatalog('chat');
    await useModelRolesStore.getState().loadCatalog('chat');
    expect(listCatalog).toHaveBeenCalledTimes(1);
  });

  it('force:true re-fetches even when a result is already cached, and keeps the OLD error visible until the new result lands', async () => {
    let resolveSecond!: (value: unknown) => void;
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const listCatalog = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'omp-probe-failed', message: 'first failure' } })
      .mockReturnValueOnce(secondPromise);
    stubRefract({ listCatalog });

    await useModelRolesStore.getState().loadCatalog('chat');
    expect(useModelRolesStore.getState().catalogErrors.chat).toBe('first failure');

    const retryPromise = useModelRolesStore.getState().loadCatalog('chat', true);
    // Quality-gate remediation (accessibility-auditor MEDIUM): the OLD error must still be
    // present while the retry is in flight -- the section keeps its Retry button mounted and
    // marks it 'Retrying…' itself, rather than this store clearing the error up front and
    // causing an unmount mid-retry.
    expect(useModelRolesStore.getState().catalogErrors.chat).toBe('first failure');

    resolveSecond({ ok: true, value: [] });
    await retryPromise;
    expect(useModelRolesStore.getState().catalogErrors.chat).toBeUndefined();
    expect(useModelRolesStore.getState().catalogs.chat).toEqual([]);
    expect(listCatalog).toHaveBeenCalledTimes(2);
  });

  it('a second force:true call for the SAME kind, made before the first resolves, joins the first in-flight promise', async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const listCatalog = vi.fn(() => firstPromise);
    stubRefract({ listCatalog });

    const first = useModelRolesStore.getState().loadCatalog('chat', true);
    const second = useModelRolesStore.getState().loadCatalog('chat', true);
    expect(first).toBe(second);

    resolveFirst({ ok: true, value: [] });
    await first;
    await second;
    expect(listCatalog).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls for DIFFERENT kinds each fetch independently -- the in-flight tracking is per kind, not a single shared slot', async () => {
    // Gate cycle 5 MEDIUM (test-reviewer): the realistic implementation mistake this guards
    // against is a single in-flight slot instead of a `Map` keyed by kind -- the section's own
    // mount effect fires one `loadCatalog(kind, true)`-equivalent call per distinct catalog kind
    // (up to 7) at the same moment, and a single shared slot would hand every kind the FIRST
    // kind's promise, silently leaving the other six catalogs never loaded with no test failing.
    let resolveChat!: (value: unknown) => void;
    const chatPromise = new Promise((resolve) => {
      resolveChat = resolve;
    });
    let resolveImage!: (value: unknown) => void;
    const imagePromise = new Promise((resolve) => {
      resolveImage = resolve;
    });
    const listCatalog = vi.fn((kind: string) => (kind === 'chat' ? chatPromise : imagePromise));
    stubRefract({ listCatalog });

    const chatCall = useModelRolesStore.getState().loadCatalog('chat', true);
    const imageCall = useModelRolesStore.getState().loadCatalog('image', true);
    expect(chatCall).not.toBe(imageCall);

    resolveChat({ ok: true, value: [{ provider: 'p', id: 'chat-model', selector: 'p/chat-model', name: 'Chat Model' }] });
    resolveImage({ ok: true, value: [{ provider: 'p', id: 'image-model', selector: 'p/image-model', name: 'Image Model' }] });
    await chatCall;
    await imageCall;

    expect(listCatalog).toHaveBeenCalledTimes(2);
    expect(listCatalog).toHaveBeenCalledWith('chat');
    expect(listCatalog).toHaveBeenCalledWith('image');
    expect(useModelRolesStore.getState().catalogs.chat).toEqual([{ provider: 'p', id: 'chat-model', selector: 'p/chat-model', name: 'Chat Model' }]);
    expect(useModelRolesStore.getState().catalogs.image).toEqual([{ provider: 'p', id: 'image-model', selector: 'p/image-model', name: 'Image Model' }]);
  });
});
