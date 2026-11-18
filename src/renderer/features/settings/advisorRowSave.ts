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

/**
 * The polite message after the Advisor write settled, or `null` when it failed. A failure (the call rejected, or the
 * store recorded an error) is already announced by the `alert` the row renders from the same store entry, so
 * announcing it here too would read it twice.
 */
export function advisorSaveAnnouncement(rejected: boolean, outcome: KeySave | undefined, next: string | null, announcement?: string): string | null {
  if (rejected || outcome?.state === 'error') return null
  return announcement ?? (next === null ? 'Advisor reset to the Refract default' : 'Advisor saved; applies to new Sessions')
}
