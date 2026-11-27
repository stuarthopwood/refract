import * as React from 'react'

export function readDevicePixelRatio(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
}

/** Calls `notify` whenever `window.devicePixelRatio` changes (the window moved to another monitor,
 * or the display scale or browser zoom changed). A `resolution` media query only fires for the one
 * ratio it names, so it is re-armed for the new ratio after every change. */
export function subscribeDevicePixelRatio(notify: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  let query: MediaQueryList
  const onChange = () => {
    query.removeEventListener('change', onChange)
    arm()
    notify()
  }
  const arm = () => {
    query = window.matchMedia(`(resolution: ${readDevicePixelRatio()}dppx)`)
    query.addEventListener('change', onChange)
  }
  arm()
  return () => query.removeEventListener('change', onChange)
}

/** The live device pixel ratio; the component re-renders when it changes. */
export function useDevicePixelRatio(): number {
  return React.useSyncExternalStore(subscribeDevicePixelRatio, readDevicePixelRatio, readDevicePixelRatio)
}
