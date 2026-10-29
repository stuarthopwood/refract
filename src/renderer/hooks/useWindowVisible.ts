// True while the window is visible. A single module-level `visibilitychange` listener serves every
// subscriber (each status shimmer used to register its own).
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

function subscribe(onChange: () => void): () => void {
  if (listeners.size === 0) document.addEventListener('visibilitychange', notify)
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) document.removeEventListener('visibilitychange', notify)
  }
}

export function useWindowVisible(): boolean {
  return useSyncExternalStore(subscribe, () => !document.hidden)
}
