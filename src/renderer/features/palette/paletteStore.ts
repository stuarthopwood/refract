import { create } from 'zustand'

interface PaletteState {
  open: boolean
  setOpen(open: boolean): void
}

/** Whether the command palette is showing. */
export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))
