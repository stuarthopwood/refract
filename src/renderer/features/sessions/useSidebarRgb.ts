import { useSyncExternalStore } from 'react'
import { readSidebarRgbs } from '@/lib/projectColor'

type Rgb = [number, number, number]

// The Session list backgrounds as RGB, shared by every Project header and the colour popover:
// one MutationObserver on the root element's theme class and one cached read, so a custom
// Project colour is re-adjusted for the active theme without a probe per consumer.
let cached: Rgb[] | null | undefined
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

const same = (a: Rgb[] | null, b: Rgb[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((rgb, i) => rgb.every((v, j) => v === b[i]![j])))

function refresh() {
  const next = readSidebarRgbs()
  if (cached !== undefined && same(cached, next)) return
  cached = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!observer) {
    observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
      cached = undefined
    }
  }
}

function getSnapshot(): Rgb[] | null {
  if (cached === undefined) cached = readSidebarRgbs()
  return cached
}

export function useSidebarRgb(): Rgb[] | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}
