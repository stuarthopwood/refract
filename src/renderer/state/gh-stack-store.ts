// One shared reading of the `gh stack` extension (#1867), so Settings, the Merge dialog and the
// Pull requests view agree on it. Probed on demand, never polled; Install returns the re-probed state.
import { create } from 'zustand'
import type { GhStackState } from '../../shared/ipc-github-stack'

interface GhStackStore {
  /** `null` until the first probe settles, or when `gh` itself could not answer. */
  state: GhStackState | null
  installing: boolean
  /** The last probe or install failure, in `gh`'s words; cleared by the next attempt. */
  error: string | null
  load(): Promise<void>
  install(): Promise<void>
}

// Pull requests list and detail mount together; they must share one probe, not launch two.
let inFlight: Promise<void> | null = null

export const useGhStackStore = create<GhStackStore>((set) => ({
  state: null,
  installing: false,
  error: null,
  load: () => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const result = await window.refract.githubStack.state()
        set(result.ok ? { state: result.value, error: null } : { state: null, error: result.error.message })
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  },
  install: async () => {
    set({ installing: true, error: null })
    const result = await window.refract.githubStack.install()
    // A failed install keeps the prompt that was showing, so only the error changes.
    set(result.ok ? { installing: false, state: result.value } : { installing: false, error: result.error.message })
  }
}))
