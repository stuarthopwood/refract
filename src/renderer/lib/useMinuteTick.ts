import { useSyncExternalStore } from 'react'

// #567 decision 11: "One shared app-level tick, aligned to the minute, updates every row (no
// timer per row)." Today's `sessionDisplay.tsx` time text is only recomputed when a row happens
// to re-render for an unrelated reason, so it silently goes stale between renders -- this is the
// one shared subscription every Session row (`SessionRow.tsx`) reads instead, backed by exactly
// one `setTimeout`/`setInterval` pair for the whole app regardless of how many rows are mounted.
let tick = 0
const listeners = new Set<() => void>()
// Browser `setTimeout`/`setInterval` (renderer/DOM code, not Node) return a numeric handle, the
// same pattern `session-list-store.ts`'s own `persistTimer` uses.
let timeoutHandle: number | undefined
let intervalHandle: number | undefined

function start(): void {
  // Aligns the very first tick to the next real minute boundary. Every tick after that is a
  // plain 60s `setInterval`, which drifts over a long session (timer coalescing, background-tab
  // throttling) rather than staying perfectly aligned -- harmless here, since the visible text
  // this drives rounds to the nearest minute anyway, so a few seconds of drift never shows.
  const msToNextMinute = 60_000 - (Date.now() % 60_000)
  timeoutHandle = setTimeout(() => {
    tick++
    for (const listener of listeners) listener()
    intervalHandle = setInterval(() => {
      tick++
      for (const listener of listeners) listener()
    }, 60_000)
  }, msToNextMinute)
}

function stop(): void {
  clearTimeout(timeoutHandle)
  clearInterval(intervalHandle)
  timeoutHandle = undefined
  intervalHandle = undefined
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

/** Re-renders the calling component once a minute, aligned to the minute boundary. Every mounted
 *  Session row subscribes to the same tick, so every row's relative time redraws together off
 *  one shared timer (#567 decision 11) -- the return value itself carries no meaning, only its
 *  change does. */
export function useMinuteTick(): number {
  return useSyncExternalStore(
    subscribe,
    () => tick,
    () => tick
  )
}
