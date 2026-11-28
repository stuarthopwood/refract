// FR-204: the Agents panel is global, so an agent can reach it from any Session; every other panel still needs the front Session.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionsStore, useSplitStore } from '@/state'
import { isAvailable, openPanel } from './agent-tool-dispatch'

// Store modules touch `window`/`document` at import time, so the stubs must exist before the imports run.
vi.hoisted(() => {
  const noop = (): undefined => undefined
  vi.stubGlobal('window', { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), refract: { settings: { setSplit: () => Promise.resolve({ ok: true }) }, chat: { setVisibleSubagent: () => Promise.resolve() } }, setTimeout: () => 0, clearTimeout: noop })
  vi.stubGlobal('document', { addEventListener: noop, hidden: false, visibilityState: 'visible', activeElement: null, body: {}, querySelector: () => null, getElementById: () => null, documentElement: { dataset: {}, style: { setProperty: noop, removeProperty: noop }, classList: { toggle: noop, add: noop, remove: noop } } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
})
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }) }))

const started = async () => true

beforeEach(() => {
  useSplitStore.setState({ paneSessionIds: ['front'], focusedIndex: 0 })
  useSessionsStore.setState({ sessions: [] })
})

describe('isAvailable', () => {
  it('keeps the Agents panel available to a Session that is not the front one', () => {
    expect(isAvailable('background', 'subagents')).toBe(true)
    expect(isAvailable('front', 'subagents')).toBe(true)
  })

  it('leaves every other panel tied to the front Session', () => {
    expect(isAvailable('front', 'outline')).toBe(true)
    expect(isAvailable('background', 'outline')).toBe(false)
  })
})

describe('openPanel', () => {
  it('opens the Agents panel for a background Session and refuses another panel for it', async () => {
    expect(await openPanel('background', 'subagents', undefined, started)).toEqual({ ok: true, value: { panelId: 'subagents' } })
    expect(await openPanel('background', 'outline', undefined, started)).toMatchObject({ ok: false, code: 'panel_unavailable' })
  })
})
