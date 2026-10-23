import { create } from 'zustand'
import { DEFAULT_SESSION_LIST_COLLAPSE } from '../../shared/model'
import type { SessionListCollapse } from '../../shared/model'

/** Decision 18 (gate round 1, code-reviewer Medium): the one place `override.repositories.get`'s
 * default lives -- a Project absent from the override map is open (matching `isGroupOpen`'s own
 * no-override default), repeated four times before this helper existed. */
function overrideOpen(override: { repositories: Map<string, boolean> }, repositoryId: string): boolean {
  return override.repositories.get(repositoryId) ?? true
}

// Issue #735 (decision record): collapsed/expanded state for the session
// list's per-Repository groups and the cross-repository Archived group (#527), persisted in
// `Settings.sessionListCollapse`. Lives in its own store rather than `useSettingsStore`
// (decision 16): a per-Repository record (option B) cannot hold Archived at all -- it has no
// Repository record of its own -- and would add view state to `registry.json` and its rollback
// paths. Storing only the DIFFERENCE from each group's default here makes "a new Project opens,
// Archived starts closed" true for free, and #638's Repository reordering can never disturb a
// `Set` keyed by Repository id the way a positional array could.
//
// This store is the ONE writer of `sessionListCollapse` (decision 17): `restore()` below
// reads Settings once at startup (`init-stores.ts`) and every other action here updates local
// state immediately, then persists it debounced -- the store never reads a setter's own reply or
// a later `settings:changed` broadcast back into itself, so a broadcast from an unrelated setter
// arriving mid-debounce can never undo a toggle this store just made. Not added to
// `useSettingsStore`'s own action list for the same reason.
interface SessionListState {
  /** Ids of Repository groups the user has explicitly collapsed; a Repository absent here is
   * open -- the default for every newly added Project (decision 16). */
  collapsedRepositoryIds: Set<string>
  archivedOpen: boolean
  /** False until `restore()` has run once at startup (decision 19): `SessionList` renders
   * only its own fixed chrome until this flips true, so a Repository group never paints open
   * and then immediately snaps shut once the persisted state loads a moment later -- Repositories
   * load in a separate, later async step than Settings and would otherwise race it. */
  restored: boolean
  /** Issue #559 decisions 17, 27: the session list's own search query. Lives here (never
   * persisted) because #735 decision 26 already reserved this store for the open/closed
   * override a query needs -- see `searchOverride` below. */
  query: string
  /** Non-null exactly while `query.trim()` is non-empty (decisions 17, 21): an ephemeral,
   * never-persisted view of every group's open/closed state during a search, created empty
   * (every Project and Archived start open) the moment a query begins and discarded -- not
   * merged back -- the moment it empties, so the saved layout returns exactly unchanged.
   * `isGroupOpen`/`isArchivedGroupOpen` read through this first; every toggle/collapse/expand
   * action writes only here, and never calls `persist()`, while it is set. */
  searchOverride: { repositories: Map<string, boolean>; archivedOpen: boolean } | null
  setQuery(query: string): void
  /** Decision 26: a selector so a later story (#559 search) can override it while a query is
   * active without this store ever writing that override back out as the saved state. */
  isGroupOpen(repositoryId: string): boolean
  /** Issue #559 decision 18: the same override-or-saved rule as `isGroupOpen`, for the
   * Archived group -- `ArchivedGroup.tsx` reads this instead of the raw `archivedOpen` field so
   * a search's override reaches it too. */
  isArchivedGroupOpen(): boolean
  /** Driven by Radix's own `onOpenChange` value, never a blind toggle -- a redundant call with
   * the current value must be a no-op, not an inversion. */
  setRepositoryOpen(repositoryId: string, open: boolean): void
  setArchivedOpen(open: boolean): void
  /** The toolbar's two buttons (decisions 5, 11): every Project group, plus Archived while it is
   * currently shown (`archivedVisible` -- #527's own "hidden entirely while nothing anywhere is
   * archived" rule). While Archived is hidden, its saved flag is left untouched. */
  collapseAll(repositoryIds: string[], archivedVisible: boolean): void
  expandAll(repositoryIds: string[], archivedVisible: boolean): void
  /** Decision 20: opens a closed Repository group the moment a create or restore actually
   * succeeds and moves a row into it (`sessions-store.ts`'s `create`/`restore`) -- never for a
   * plain selection, a Split restore, or a status change. A no-op if already open. */
  openRepositoryGroup(repositoryId: string): void
  /** Reads `Settings.sessionListCollapse` once at startup and flips `restored` true either way,
   * including when `settings.get` itself failed and this runs against the shared
   * `DEFAULT_SETTINGS` fallback (decision 19) -- never itself a persisting write. */
  restore(value: SessionListCollapse): void
  /** Decision 18: drops every collapsed-repository id no longer present. Called only after
   * a successful `repositories.list` load or a successful `repositories.remove` -- never against
   * an empty failure fallback, which would wipe the user's whole saved layout. */
  pruneRepositories(existingIds: Set<string>): void
}

export const useSessionListStore = create<SessionListState>((set, get) => {
  // Browser `setTimeout` (renderer/DOM code, not Node) returns a numeric handle, the same
  // pattern `split-store.ts`'s own `persist` uses.
  let persistTimer: number | undefined

  // Decision 17: the setter writes the WHOLE value, and this store never reads the reply or a
  // later broadcast back into itself.
  function persist(immediate = false): void {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
    const run = (): void => {
      const { collapsedRepositoryIds, archivedOpen } = get()
      const value: SessionListCollapse = {
        collapsedRepositoryIds: [...collapsedRepositoryIds],
        archivedOpen
      }
      window.refract.settings.setSessionListCollapse(value).then(
        (result) => {
          if (!result.ok) console.error('settings.setSessionListCollapse failed', result.error)
        },
        (err: unknown) => console.error('settings.setSessionListCollapse threw', err)
      )
    }
    if (immediate) run()
    else
      persistTimer = setTimeout(() => {
        persistTimer = undefined
        run()
      }, 300)
  }

  // Decision 17: flushes a pending debounced write on quit, the same `beforeunload`/`pagehide`
  // pattern `split-store.ts` uses, so a toggle made just before closing the app is not lost.
  if (typeof window !== 'undefined') {
    const flushPending = (): void => {
      if (persistTimer) persist(true)
    }
    window.addEventListener('beforeunload', flushPending)
    window.addEventListener('pagehide', flushPending)
  }

  return {
    collapsedRepositoryIds: new Set(DEFAULT_SESSION_LIST_COLLAPSE.collapsedRepositoryIds),
    archivedOpen: DEFAULT_SESSION_LIST_COLLAPSE.archivedOpen,
    restored: false,
    query: '',
    searchOverride: null,
    setQuery: (query) => {
      // Issue #559 decisions 17, 21: the override is created (every group starts open) the
      // instant the trimmed query goes empty -> non-empty, and discarded -- not merged back --
      // the instant it goes non-empty -> empty, so the saved layout returns exactly unchanged.
      const hasQuery = query.trim() !== ''
      const hadOverride = get().searchOverride !== null
      if (hasQuery && !hadOverride) {
        set({ query, searchOverride: { repositories: new Map(), archivedOpen: true } })
      } else if (!hasQuery && hadOverride) {
        set({ query, searchOverride: null })
      } else {
        set({ query })
      }
    },
    isGroupOpen: (repositoryId) => {
      const override = get().searchOverride
      if (override) return overrideOpen(override, repositoryId)
      return !get().collapsedRepositoryIds.has(repositoryId)
    },
    isArchivedGroupOpen: () => {
      const override = get().searchOverride
      return override ? override.archivedOpen : get().archivedOpen
    },
    setRepositoryOpen: (repositoryId, open) => {
      // Issue #559 decision 17: while a search is active, every toggle writes only to the
      // ephemeral override and never calls `persist()` -- the saved layout is untouched.
      const override = get().searchOverride
      if (override) {
        if (overrideOpen(override, repositoryId) === open) return
        const repositoriesOverride = new Map(override.repositories)
        repositoriesOverride.set(repositoryId, open)
        set({ searchOverride: { ...override, repositories: repositoriesOverride } })
        return
      }
      if (get().collapsedRepositoryIds.has(repositoryId) === !open) return
      const collapsedRepositoryIds = new Set(get().collapsedRepositoryIds)
      if (open) collapsedRepositoryIds.delete(repositoryId)
      else collapsedRepositoryIds.add(repositoryId)
      set({ collapsedRepositoryIds })
      persist()
    },
    setArchivedOpen: (open) => {
      const override = get().searchOverride
      if (override) {
        if (override.archivedOpen === open) return
        set({ searchOverride: { ...override, archivedOpen: open } })
        return
      }
      if (get().archivedOpen === open) return
      set({ archivedOpen: open })
      persist()
    },
    collapseAll: (repositoryIds, archivedVisible) => {
      const override = get().searchOverride
      if (override) {
        set({
          searchOverride: {
            repositories: new Map(repositoryIds.map((id) => [id, false])),
            archivedOpen: archivedVisible ? false : override.archivedOpen
          }
        })
        return
      }
      set((state) => ({
        collapsedRepositoryIds: new Set(repositoryIds),
        archivedOpen: archivedVisible ? false : state.archivedOpen
      }))
      persist()
    },
    expandAll: (repositoryIds, archivedVisible) => {
      const override = get().searchOverride
      if (override) {
        set({
          searchOverride: {
            repositories: new Map(repositoryIds.map((id) => [id, true])),
            archivedOpen: archivedVisible ? true : override.archivedOpen
          }
        })
        return
      }
      set((state) => ({
        collapsedRepositoryIds: new Set(),
        archivedOpen: archivedVisible ? true : state.archivedOpen
      }))
      persist()
    },
    openRepositoryGroup: (repositoryId) => {
      // Issue #559 decision 20: this always writes the saved state too (an action's own real
      // outcome, not part of the search), so a restored/created row is never hidden by a
      // collapse the user made during this same search once the query later clears.
      if (get().collapsedRepositoryIds.has(repositoryId)) {
        const collapsedRepositoryIds = new Set(get().collapsedRepositoryIds)
        collapsedRepositoryIds.delete(repositoryId)
        set({ collapsedRepositoryIds })
        persist()
      }
      const override = get().searchOverride
      if (override && overrideOpen(override, repositoryId) !== true) {
        const repositoriesOverride = new Map(override.repositories)
        repositoriesOverride.set(repositoryId, true)
        set({ searchOverride: { ...override, repositories: repositoriesOverride } })
      }
    },
    restore: (value) => {
      set({
        collapsedRepositoryIds: new Set(value.collapsedRepositoryIds),
        archivedOpen: value.archivedOpen,
        restored: true
      })
    },
    pruneRepositories: (existingIds) => {
      const current = get().collapsedRepositoryIds
      const pruned = new Set([...current].filter((id) => existingIds.has(id)))
      if (pruned.size === current.size) return
      set({ collapsedRepositoryIds: pruned })
      persist()
    }
  }
})
