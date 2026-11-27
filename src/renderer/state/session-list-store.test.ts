// #1862: the parent collapse state. `environment: 'node'` has no `window`, so the settings bridge is
// a stub on `globalThis`; the store's debounced write runs on fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_LIST_COLLAPSE } from '../../shared/model';
import { useSessionListStore } from './session-list-store';

const setSessionListCollapse = vi.fn(() => Promise.resolve({ ok: true, value: {} }));

beforeEach(() => {
  vi.useFakeTimers();
  setSessionListCollapse.mockClear();
  (globalThis as unknown as { window: unknown }).window = { refract: { settings: { setSessionListCollapse } } };
  useSessionListStore.setState({
    collapsedRepositoryIds: new Set(),
    collapsedParentIds: new Set(),
    archivedOpen: false,
    showHidden: false,
    query: '',
    searchOverride: null,
    restored: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parent collapse', () => {
  it('shows every parent expanded by default', () => {
    expect(useSessionListStore.getState().isParentOpen('p')).toBe(true);
  });

  it('collapses on toggle and writes the whole value once the debounce settles', () => {
    useSessionListStore.getState().toggleParent('p');
    expect(useSessionListStore.getState().isParentOpen('p')).toBe(false);
    expect(setSessionListCollapse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).toHaveBeenCalledTimes(1);
    expect(setSessionListCollapse).toHaveBeenCalledWith({
      collapsedRepositoryIds: [],
      archivedOpen: false,
      collapsedParentIds: ['p'],
    });
  });

  it('expands again on a second toggle and persists the empty set', () => {
    const { toggleParent } = useSessionListStore.getState();
    toggleParent('p');
    toggleParent('p');
    expect(useSessionListStore.getState().isParentOpen('p')).toBe(true);

    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).toHaveBeenCalledTimes(1);
    expect(setSessionListCollapse).toHaveBeenCalledWith(expect.objectContaining({ collapsedParentIds: [] }));
  });

  it('restores the saved collapsed parents without writing them back', () => {
    useSessionListStore.getState().restore({ ...DEFAULT_SESSION_LIST_COLLAPSE, collapsedParentIds: ['a', 'b'] });
    const state = useSessionListStore.getState();
    expect(state.isParentOpen('a')).toBe(false);
    expect(state.isParentOpen('c')).toBe(true);
    expect(state.restored).toBe(true);

    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).not.toHaveBeenCalled();
  });

  it('restores from a value that carries no parent field as nothing collapsed', () => {
    const { collapsedParentIds: _omitted, ...legacy } = DEFAULT_SESSION_LIST_COLLAPSE;
    useSessionListStore.getState().restore(legacy as typeof DEFAULT_SESSION_LIST_COLLAPSE);
    expect(useSessionListStore.getState().isParentOpen('a')).toBe(true);
  });

  it('prunes ids with no live child and persists the smaller set', () => {
    useSessionListStore.setState({ collapsedParentIds: new Set(['keep', 'gone']) });
    useSessionListStore.getState().pruneParents(new Set(['keep']));
    expect([...useSessionListStore.getState().collapsedParentIds]).toEqual(['keep']);

    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).toHaveBeenCalledWith(expect.objectContaining({ collapsedParentIds: ['keep'] }));
  });

  it('writes nothing when every collapsed parent still has a live child', () => {
    useSessionListStore.setState({ collapsedParentIds: new Set(['keep']) });
    useSessionListStore.getState().pruneParents(new Set(['keep', 'other']));
    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).not.toHaveBeenCalled();
  });
});

describe('parent collapse during a search', () => {
  it('opens every parent while a query is active, even a saved-collapsed one', () => {
    useSessionListStore.setState({ collapsedParentIds: new Set(['p']) });
    useSessionListStore.getState().setQuery('abc');
    expect(useSessionListStore.getState().isParentOpen('p')).toBe(true);
  });

  it('writes a toggle to the override only and leaves the saved set alone', () => {
    useSessionListStore.getState().setQuery('abc');
    useSessionListStore.getState().toggleParent('p');
    expect(useSessionListStore.getState().isParentOpen('p')).toBe(false);
    expect(useSessionListStore.getState().collapsedParentIds.size).toBe(0);

    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).not.toHaveBeenCalled();
  });

  it('drops the override when the query clears, so the saved layout returns unchanged', () => {
    useSessionListStore.setState({ collapsedParentIds: new Set(['p']) });
    useSessionListStore.getState().setQuery('abc');
    useSessionListStore.getState().toggleParent('p');
    useSessionListStore.getState().setQuery('');

    expect(useSessionListStore.getState().searchOverride).toBeNull();
    expect(useSessionListStore.getState().isParentOpen('p')).toBe(false);
  });

  it('leaves parents alone on Collapse all and Expand all, with and without a query', () => {
    useSessionListStore.setState({ collapsedParentIds: new Set(['p']) });
    useSessionListStore.getState().collapseAll(['r'], false);
    useSessionListStore.getState().expandAll(['r'], false);
    expect([...useSessionListStore.getState().collapsedParentIds]).toEqual(['p']);

    useSessionListStore.getState().setQuery('abc');
    useSessionListStore.getState().toggleParent('q');
    useSessionListStore.getState().collapseAll(['r'], false);
    expect(useSessionListStore.getState().isParentOpen('q')).toBe(false);
    useSessionListStore.getState().expandAll(['r'], false);
    expect(useSessionListStore.getState().isParentOpen('q')).toBe(false);
  });
});

describe('Show hidden is a filter held in memory (#1850)', () => {
  it('starts off in a fresh store, before any restore or toggle', () => {
    expect(useSessionListStore.getInitialState().showHidden).toBe(false);
  });

  it('keeps the toggle without writing it to disk', () => {
    useSessionListStore.getState().setShowHidden(true);
    expect(useSessionListStore.getState().showHidden).toBe(true);

    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).not.toHaveBeenCalled();
  });

  it('leaves it off after a restore, even from a file saved with it on', () => {
    const legacy = { ...DEFAULT_SESSION_LIST_COLLAPSE, showHidden: true };
    useSessionListStore.getState().restore(legacy);
    expect(useSessionListStore.getState().showHidden).toBe(false);
  });

  it('does not send it when a collapse change is saved', () => {
    useSessionListStore.getState().setShowHidden(true);
    useSessionListStore.getState().toggleParent('p');
    vi.advanceTimersByTime(300);
    expect(setSessionListCollapse).toHaveBeenCalledWith(
      expect.not.objectContaining({ showHidden: expect.anything() }),
    );
  });
});
