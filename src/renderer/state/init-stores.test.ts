import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Store modules touch `window`/`document` at import time (`state/index.ts`, `session-list-store.ts`), so they must exist before the imports below run.
vi.hoisted(() => {
  const noop = (): undefined => undefined
  vi.stubGlobal('window', { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) })
  vi.stubGlobal('document', {
    addEventListener: noop,
    hidden: false,
    visibilityState: 'visible',
    documentElement: { dataset: {}, style: { setProperty: noop, removeProperty: noop }, classList: { toggle: noop, add: noop, remove: noop } }
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
})

// sonner injects a stylesheet through `document` at import time; initStores never renders a toast on this path.
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }) }))

import { openGateAfterFirstFrame, resetFirstFrameGateForTests } from './first-frame'
import { initStores } from './init-stores'

// The non-visual loads FR-184 defers: GitHub accounts (gates the PR count), update state, holiday overrides.
const DEFERRED_CALLS = ['accounts.github.list', 'updates.getState', 'debug.getOverrides']

let calls: string[] = []
let frame: (() => void) | null = null

/** Any `window.refract.a.b(...)` records `a.b`, returns a failed Result, and any `onX(...)` subscription is a no-op. */
function recordingApi(path: string[] = []): unknown {
  return new Proxy(() => undefined, {
    get: (_target, name) => (typeof name === 'string' && name !== 'then' ? recordingApi([...path, name]) : undefined),
    apply: () => {
      calls.push(path.join('.'))
      return Promise.resolve({ ok: false, error: { code: 'test', message: 'recorded' } })
    }
  })
}

beforeEach(() => {
  calls = []
  frame = null
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('window', { ...window, refract: recordingApi(), setTimeout: globalThis.setTimeout })
  resetFirstFrameGateForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('initStores startup ordering (FR-184)', () => {
  it('starts_no_non_visual_load_before_the_first_frame_has_painted', async () => {
    initStores()
    openGateAfterFirstFrame()
    frame?.()
    for (const deferred of DEFERRED_CALLS) expect(calls).not.toContain(deferred)
    await vi.advanceTimersByTimeAsync(0)
  })

  it('starts_the_deferred_loads_once_the_first_frame_has_painted', async () => {
    initStores()
    openGateAfterFirstFrame()
    frame?.()
    await vi.advanceTimersByTimeAsync(0)
    for (const deferred of DEFERRED_CALLS) expect(calls).toContain(deferred)
  })

  it('still_runs_the_layout_critical_loads_before_the_first_frame', async () => {
    initStores()
    expect(calls).toContain('settings.get')
    expect(calls).toContain('repositories.list')
    await vi.advanceTimersByTimeAsync(0)
  })
})
