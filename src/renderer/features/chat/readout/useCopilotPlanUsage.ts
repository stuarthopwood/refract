// Issue #1238 (spec 004 FR-051): the user's individual Copilot plan usage for the Context usage
// chip's tooltip. One shared 5-minute cache (the Rust side caches too), so several open Sessions
// and every settle share one lookup. `null` = unavailable.
import { useEffect, useState } from 'react'

const CACHE_MS = 5 * 60 * 1000

let cached: { at: number; percentUsed: number | null } | null = null
let inFlight: Promise<number | null> | null = null

function loadPlanUsage(): Promise<number | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.percentUsed)
  inFlight ??= window.refract.copilot
    .planUsage()
    .then((result) => (result.ok && result.value ? result.value.percentUsed : null))
    .catch(() => null)
    .then((percentUsed) => {
      cached = { at: Date.now(), percentUsed }
      inFlight = null
      return percentUsed
    })
  return inFlight
}

/** `enabled` false never calls the lookup. Re-reads whenever `refreshKey` changes (the session's
 * credits), still bounded by the shared cache. */
export function useCopilotPlanUsage(enabled: boolean, refreshKey: unknown): number | null {
  const [percentUsed, setPercentUsed] = useState<number | null>(cached?.percentUsed ?? null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    void loadPlanUsage().then((value) => {
      if (live) setPercentUsed(value)
    })
    return () => {
      live = false
    }
  }, [enabled, refreshKey])
  return enabled ? percentUsed : null
}
