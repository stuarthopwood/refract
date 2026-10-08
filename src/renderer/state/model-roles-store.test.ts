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

  it('a failing keepError:true retry keeps loaded true and replaces loadError with the new message', async () => {
    useModelRolesStore.setState({ loaded: true, loadError: 'first failure' });
    stubRefract({ list: vi.fn(async () => ({ ok: false, error: { code: 'omp-probe-failed', message: 'second failure' } })) });
    await useModelRolesStore.getState().load({ keepError: true });
    expect(useModelRolesStore.getState().loaded).toBe(true);
    expect(useModelRolesStore.getState().loadError).toBe('second failure');
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
});
