import { create } from 'zustand'
import { DEFAULT_SESSION_LIST_COLLAPSE } from '../../shared/model'
import type { SessionListCollapse } from '../../shared/model'

// Issue #735 (decision record, decisions 63-95): collapsed/expanded state for the session
// list's per-Repository groups and the cross-repository Archived group (#527), persisted in
// `Settings.sessionListCollapse`. Lives in its own store rather than `useSettingsStore`
// (decision 72): a per-Repository record (option B) cannot hold Archived at all -- it has no
// Repository record of its own -- and would add view state to `registry.json` and its rollback
// paths. Storing only the DIFFERENCE from each group's default here makes "a new Project opens,
// Archived starts closed" true for free, and #638's Repository reordering can never disturb a
// `Set` keyed by Repository id the way a positional array could.
//
// This store is the ONE writer of `sessionListCollapse` (decisions 74-78): `restore()` below
// reads Settings once at startup (`init-stores.ts`) and every other action here updates local
// state immediately, then persists it debounced -- the store never reads a setter's own reply or
// a later `settings:changed` broadcast back into itself, so a broadcast from an unrelated setter
// arriving mid-debounce can never undo a toggle this store just made. Not added to
// `useSettingsStore`'s own action list for the same reason.
interface SessionListState {
  /** Ids of Repository groups the user has explicitly collapsed; a Repository absent here is
   * open -- the default for every newly added Project (decision 72). */
  collapsedRepositoryIds: Set<string>
  archivedOpen: boolean
  /** False until `restore()` has run once at startup (decisions 83-86): `SessionList` renders
   * only its own fixed chrome until this flips true, so a Repository group never paints open
   * and then immediately snaps shut once the persisted state loads a moment later -- Repositories
   * load in a separate, later async step than Settings and would otherwise race it. */
  restored: boolean
  /** Decision 121: a selector so a later story (#559 search) can override it while a query is
   * active without this store ever writing that override back out as the saved state. */
  isGroupOpen(repositoryId: string): boolean
  toggleRepository(repositoryId: string): void
  setArchivedOpen(open: boolean): void
  /** The toolbar's two buttons (decisions 5, 11): every Project group, plus Archived while it is
   * currently shown (`archivedVisible` -- #527's own "hidden entirely while nothing anywhere is
   * archived" rule). While Archived is hidden, its saved flag is left untouched. */
  collapseAll(repositoryIds: string[], archivedVisible: boolean): void
  expandAll(repositoryIds: string[], archivedVisible: boolean): void
  /** Decisions 88-90: opens a closed Repository group the moment a create or restore actually
   * succeeds and moves a row into it (`sessions-store.ts`'s `create`/`restore`) -- never for a
   * plain selection, a Split restore, or a status change. A no-op if already open. */
  openRepositoryGroup(repositoryId: string): void
  /** Reads `Settings.sessionListCollapse` once at startup and flips `restored` true either way,
   * including when `settings.get` itself failed and this runs against the shared
   * `DEFAULT_SETTINGS` fallback (decision 84) -- never itself a persisting write. */
  restore(value: SessionListCollapse): void
  /** Decisions 79-82: drops every collapsed-repository id no longer present. Called only after
   * a successful `repositories.list` load or a successful `repositories.remove` -- never against
   * an empty failure fallback, which would wipe the user's whole saved layout. */
  pruneRepositories(existingIds: Set<string>): void
}

export const useSessionListStore = create<SessionListState>((set, get) => {
  // Browser `setTimeout` (renderer/DOM code, not Node) returns a numeric handle, the same
  // pattern `split-store.ts`'s own `persist` uses.
  let persistTimer: number | undefined

  // Decision 69: the setter writes the WHOLE value; decision 77: this store never reads the
  // reply or a later broadcast back into itself.
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

  // Decision 76: flushes a pending debounced write on quit, the same `beforeunload`/`pagehide`
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
    isGroupOpen: (repositoryId) => !get().collapsedRepositoryIds.has(repositoryId),
    toggleRepository: (repositoryId) => {
      const collapsedRepositoryIds = new Set(get().collapsedRepositoryIds)
      if (collapsedRepositoryIds.has(repositoryId)) collapsedRepositoryIds.delete(repositoryId)
      else collapsedRepositoryIds.add(repositoryId)
      set({ collapsedRepositoryIds })
      persist()
    },
    setArchivedOpen: (open) => {
      if (get().archivedOpen === open) return
      set({ archivedOpen: open })
      persist()
    },
    collapseAll: (repositoryIds, archivedVisible) => {
      set((state) => ({
        collapsedRepositoryIds: new Set(repositoryIds),
        archivedOpen: archivedVisible ? false : state.archivedOpen
      }))
      persist()
    },
    expandAll: (repositoryIds, archivedVisible) => {
      set((state) => ({
        collapsedRepositoryIds: new Set(),
        archivedOpen: archivedVisible ? true : state.archivedOpen
      }))
      persist()
    },
    openRepositoryGroup: (repositoryId) => {
      if (!get().collapsedRepositoryIds.has(repositoryId)) return
      const collapsedRepositoryIds = new Set(get().collapsedRepositoryIds)
      collapsedRepositoryIds.delete(repositoryId)
      set({ collapsedRepositoryIds })
      persist()
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
