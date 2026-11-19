// Test-only: drives window keydown listeners without a DOM, since the renderer suites run in node.
import { vi } from 'vitest'

type KeydownListener = (event: KeyboardEvent) => void

export interface KeydownInit {
  key: string
  code?: string
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  repeat?: boolean
  isComposing?: boolean
}

export interface KeyboardHost {
  /** Dispatches a keydown to every registered listener; returns whether a handler called `preventDefault`. */
  press(init: KeydownInit): boolean
  listenerCount(): number
  setOverlayOpen(open: boolean): void
  /** Callbacks queued with `requestAnimationFrame`, so a test can see whether focus was scheduled to move. */
  frames: (() => void)[]
}

/** Stubs `window`, `document` and `requestAnimationFrame`; pair with `vi.unstubAllGlobals()`. */
export function installKeyboardHost(): KeyboardHost {
  const listeners = new Set<KeydownListener>()
  const frames: (() => void)[] = []
  let overlayOpen = false
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: KeydownListener) => {
      if (type === 'keydown') listeners.add(listener)
    },
    removeEventListener: (type: string, listener: KeydownListener) => {
      if (type === 'keydown') listeners.delete(listener)
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined
  })
  const elsewhere = { isConnected: true, closest: () => null, matches: () => false }
  vi.stubGlobal('document', { activeElement: elsewhere, body: {}, querySelector: () => (overlayOpen ? {} : null) })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback))
  return {
    press: (init) => {
      let prevented = false
      const event = {
        code: '',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        ...init,
        preventDefault: () => {
          prevented = true
        }
      } as unknown as KeyboardEvent
      for (const listener of [...listeners]) listener(event)
      return prevented
    },
    listenerCount: () => listeners.size,
    setOverlayOpen: (open) => {
      overlayOpen = open
    },
    frames
  }
}
