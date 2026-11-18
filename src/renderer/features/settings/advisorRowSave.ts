import type { SaveState } from '@/components/saveStatusView'
import type { KeySave } from '@/state/token-guard-store'

export interface AdvisorRowSave {
  /** True while the user's write is in flight and also until the store has loaded, when nothing is being saved yet. */
  disabled: boolean
  /** Only the user's own write says `saving`; an unloaded store is `idle`. */
  state: SaveState
  /** The value the row shows while saving. */
  pendingValue?: unknown
  error?: string
}

/** What the Advisor row shows and whether it is editable, from the store's load flag and the key's write state. */
export function deriveRowSave(loaded: boolean, save: KeySave | undefined): AdvisorRowSave {
  switch (save?.state) {
    case 'saving':
      return { disabled: true, state: 'saving', pendingValue: save.pendingValue }
    case 'saved':
      return { disabled: !loaded, state: 'saved' }
    case 'error':
      return { disabled: !loaded, state: 'error', error: save.error }
    default:
      return { disabled: !loaded, state: 'idle' }
  }
}
