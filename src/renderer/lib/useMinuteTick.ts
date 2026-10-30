import { useSyncExternalStore } from 'react'

let tick = 0
const listeners = new Set<() => void>()
let timeoutHandle: number | undefined
let intervalHandle: number | undefined

function start(): void {
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

/** Re-renders the calling component once a minute, aligned to the minute boundary. */
export function useMinuteTick(): number {
  return useSyncExternalStore(
    subscribe,
    () => tick,
    () => tick
  )
}
