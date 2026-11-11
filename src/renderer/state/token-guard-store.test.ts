// `environment: 'node'` has no real `window`; a minimal `window.refract.tokenGuard` stub is installed
// on `globalThis`, as in `model-roles-store.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TokenGuardSnapshot } from '../../shared/tokenGuard'
import { useTokenGuardStore } from './token-guard-store'

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

const STALE_OVERLAY = 'Saved, but a Session started before the migration may keep the old values: access denied'

beforeEach(() => {
  useTokenGuardStore.setState({ values: {}, defaults: {}, loaded: false, migration: null, effectiveTriggers: [], projectOverrides: [], warnings: [], error: null })
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
