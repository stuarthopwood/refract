import { create } from 'zustand'

// #1850: whether a view's filter bar is open. Held here, in memory only, so leaving a view (App.tsx
// swaps the whole main area) and coming back finds the bar as it was; a relaunch starts closed.
interface FilterBarState {
  open: Record<string, boolean>
  setOpen(viewId: string, open: boolean): void
}

export const useFilterBarStore = create<FilterBarState>((set, get) => ({
  open: {},
  setOpen: (viewId, open) => {
    if ((get().open[viewId] ?? false) === open) return
    set((state) => ({ open: { ...state.open, [viewId]: open } }))
  }
}))

type OpenUpdate = boolean | ((open: boolean) => boolean)

export function useFilterBarOpen(viewId: string): [boolean, (next: OpenUpdate) => void] {
  const open = useFilterBarStore((state) => state.open[viewId] ?? false)
  const setOpen = useFilterBarStore((state) => state.setOpen)
  // An updater sees the store's current value, not this render's, so two updates in one tick compose.
  return [open, (next) => setOpen(viewId, typeof next === 'function' ? next(useFilterBarStore.getState().open[viewId] ?? false) : next)]
}
