import { create } from 'zustand'
import { NewSessionDialog } from './NewSessionDialog'
import { focusedPaneRepository } from './newSessionInFocusedPane'
import type { ItemRef } from './startSessionFromItem'

interface ItemSessionDialogState {
  kind: ItemRef['kind'] | null
  open(kind: ItemRef['kind']): void
  close(): void
}

export const useItemSessionDialogStore = create<ItemSessionDialogState>((set) => ({
  kind: null,
  open: (kind) => set({ kind }),
  close: () => set({ kind: null })
}))

/** Palette-driven "New session from issue / pull request" dialog for the focused or sole Project. */
export function ItemSessionDialogHost() {
  const kind = useItemSessionDialogStore((s) => s.kind)
  const repository = kind ? focusedPaneRepository() : undefined
  if (!kind || !repository) return null
  return (
    <NewSessionDialog
      repository={repository}
      presetKind={kind}
      open
      onOpenChange={(open) => {
        if (!open) useItemSessionDialogStore.getState().close()
      }}
    />
  )
}
