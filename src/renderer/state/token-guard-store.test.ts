// `environment: 'node'` has no real `window`; a minimal `window.refract.tokenGuard` stub is installed
// on `globalThis`, as in `model-roles-store.test.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TokenGuardSnapshot } from '../../shared/tokenGuard'
import { useTokenGuardStore } from './token-guard-store'
import { SAVED_VISIBLE_MS } from '../components/saveStatusView'

function snapshot(warnings: string[] = []): TokenGuardSnapshot {
  return {
    values: { 'compaction.thresholdPercent': 30 },
    defaults: {},
    migration: { status: 'done' },
    effectiveTriggers: [],
    projectOverrides: [],
    warnings
  }
}

function stubTokenGuard(tokenGuard: Record<string, unknown>) {
  ;(globalThis as unknown as { window: unknown }).window = { refract: { tokenGuard } }
}

/** A promise the test settles by hand (`Promise.withResolvers` is not in the web lib). */
function deferred() {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((r) => (resolve = r))
  return { promise, resolve }
}

const STALE_OVERLAY = 'Saved, but a Session started before the migration may keep the old values: access denied'

beforeEach(() => {
  useTokenGuardStore.setState({ values: {}, defaults: {}, loaded: false, migration: null, effectiveTriggers: [], projectOverrides: [], warnings: [], error: null, saves: {} })
})

describe('useTokenGuardStore warnings', () => {
  it('keeps the saved value and surfaces the warning when a write reports one', async () => {
    stubTokenGuard({ set: vi.fn(async () => ({ ok: true, value: snapshot([STALE_OVERLAY]) })) })
    expect(await useTokenGuardStore.getState().set('compaction.thresholdPercent', 30)).toBe(true)
    expect(useTokenGuardStore.getState().values['compaction.thresholdPercent']).toBe(30)
    expect(useTokenGuardStore.getState().warnings).toEqual([STALE_OVERLAY])
  })

  it('clears the warning when the next write succeeds cleanly', async () => {
    useTokenGuardStore.setState({ warnings: [STALE_OVERLAY] })
    stubTokenGuard({ reset: vi.fn(async () => ({ ok: true, value: snapshot() })) })
    await useTokenGuardStore.getState().reset('compaction.thresholdPercent')
    expect(useTokenGuardStore.getState().warnings).toEqual([])
  })

  it('carries warnings from resetAll too', async () => {
    stubTokenGuard({ resetAll: vi.fn(async () => ({ ok: true, value: snapshot([STALE_OVERLAY]) })) })
    await useTokenGuardStore.getState().resetAll()
    expect(useTokenGuardStore.getState().warnings).toEqual([STALE_OVERLAY])
  })

  it('does not drop a write warning when a later read loads the snapshot', async () => {
    useTokenGuardStore.setState({ warnings: [STALE_OVERLAY] })
    stubTokenGuard({ get: vi.fn(async () => ({ ok: true, value: snapshot() })) })
    await useTokenGuardStore.getState().load()
    expect(useTokenGuardStore.getState().warnings).toEqual([STALE_OVERLAY])
  })

  it('replaces a warning with the error when the write fails', async () => {
    useTokenGuardStore.setState({ warnings: [STALE_OVERLAY] })
    stubTokenGuard({ set: vi.fn(async () => ({ ok: false, error: { code: 'invalid-argument', message: 'omp config set failed' } })) })
    expect(await useTokenGuardStore.getState().set('compaction.thresholdPercent', 30)).toBe(false)
    expect(useTokenGuardStore.getState().warnings).toEqual([])
    expect(useTokenGuardStore.getState().error).toBe('omp config set failed')
  })
})

describe('useTokenGuardStore per-key save state', () => {
  const KEY = 'compaction.thresholdPercent'
  const OTHER = 'grep.contextBefore'

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the pending value as saving until the write returns, for that key only', async () => {
    const call = deferred()
    stubTokenGuard({ set: vi.fn(() => call.promise) })
    const write = useTokenGuardStore.getState().set(KEY, 55)
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'saving', pendingValue: 55 })
    expect(useTokenGuardStore.getState().saves[OTHER]).toBeUndefined()
    call.resolve({ ok: true, value: snapshot() })
    await write
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'saved' })
  })

  it('clears Saved after the visible window', async () => {
    vi.useFakeTimers()
    stubTokenGuard({ set: vi.fn(async () => ({ ok: true, value: snapshot() })) })
    await useTokenGuardStore.getState().set(KEY, 55)
    vi.advanceTimersByTime(SAVED_VISIBLE_MS - 1)
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'saved' })
    vi.advanceTimersByTime(1)
    expect(useTokenGuardStore.getState().saves[KEY]).toBeUndefined()
  })

  it('does not let an old Saved timer clear a newer save', async () => {
    vi.useFakeTimers()
    stubTokenGuard({ set: vi.fn(async () => ({ ok: true, value: snapshot() })) })
    await useTokenGuardStore.getState().set(KEY, 55)
    vi.advanceTimersByTime(SAVED_VISIBLE_MS - 1)
    const call = deferred()
    stubTokenGuard({ set: vi.fn(() => call.promise) })
    const second = useTokenGuardStore.getState().set(KEY, 60)
    vi.advanceTimersByTime(5)
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'saving', pendingValue: 60 })
    call.resolve({ ok: true, value: snapshot() })
    await second
    vi.advanceTimersByTime(SAVED_VISIBLE_MS - 1)
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'saved' })
  })

  it('keeps the stored value and records the error when the write fails, leaving the key editable', async () => {
    useTokenGuardStore.setState({ values: { [KEY]: 30 } })
    stubTokenGuard({ set: vi.fn(async () => ({ ok: false, error: { code: 'invalid-argument', message: 'omp config set failed' } })) })
    await useTokenGuardStore.getState().set(KEY, 55)
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'error', error: 'omp config set failed' })
    expect(useTokenGuardStore.getState().values[KEY]).toBe(30)
  })

  it('clears the saving state when the call rejects', async () => {
    stubTokenGuard({ set: vi.fn(async () => Promise.reject(new Error('ipc down'))) })
    await expect(useTokenGuardStore.getState().set(KEY, 55)).rejects.toThrow('ipc down')
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'error', error: 'ipc down' })
  })

  it('reset shows the default as pending and then Saved', async () => {
    useTokenGuardStore.setState({ defaults: { [KEY]: 80 } })
    const call = deferred()
    stubTokenGuard({ reset: vi.fn(() => call.promise) })
    const write = useTokenGuardStore.getState().reset(KEY)
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'saving', pendingValue: 80 })
    call.resolve({ ok: true, value: snapshot() })
    await write
    expect(useTokenGuardStore.getState().saves[KEY]).toEqual({ state: 'saved' })
  })

  it('resetAll marks only the changed keys as saving and shows no Saved afterwards', async () => {
    useTokenGuardStore.setState({ values: { [KEY]: 30, [OTHER]: 1 }, defaults: { [KEY]: 80, [OTHER]: 1 } })
    const call = deferred()
    stubTokenGuard({ resetAll: vi.fn(() => call.promise) })
    const write = useTokenGuardStore.getState().resetAll()
    expect(Object.keys(useTokenGuardStore.getState().saves)).toEqual([KEY])
    call.resolve({ ok: true, value: snapshot() })
    await write
    expect(useTokenGuardStore.getState().saves).toEqual({})
  })
})
