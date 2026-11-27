import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../shared/model'
import { DEFAULT_SETTINGS, useSettingsStore } from './settings-store'

// The failure path toasts; the real notify needs a DOM.
vi.mock('./notify', () => ({ notify: vi.fn() }))

type Dataset = Record<string, string | undefined>

let dataset: Dataset
let writes: number

// Counts writes through a setter so the "skip when unchanged" behaviour is observable.
function stubDocument(): void {
  const backing: Dataset = {}
  writes = 0
  dataset = new Proxy(backing, {
    set(target, key: string, value: string) {
      writes += 1
      target[key] = value
      return true
    }
  })
  vi.stubGlobal('document', { documentElement: { dataset } })
}

function stubRefract(result: unknown): void {
  vi.stubGlobal('window', { refract: { settings: { setReduceMotion: vi.fn(async () => result) } } })
}

function withReduceMotion(value: boolean | undefined): Settings {
  return { ...DEFAULT_SETTINGS, reduceMotion: value }
}

describe('settings-store Reduce motion root attribute', () => {
  beforeEach(() => {
    stubDocument()
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sets data-reduce-motion to on when the setting is true', () => {
    useSettingsStore.getState().setSettings(withReduceMotion(true))
    expect(dataset.reduceMotion).toBe('on')
  })

  it('removes data-reduce-motion when the setting turns false', () => {
    useSettingsStore.getState().setSettings(withReduceMotion(true))
    useSettingsStore.getState().setSettings(withReduceMotion(false))
    expect(dataset.reduceMotion).toBeUndefined()
  })

  it('removes data-reduce-motion when the setting is absent', () => {
    useSettingsStore.getState().setSettings(withReduceMotion(true))
    useSettingsStore.getState().setSettings(withReduceMotion(undefined))
    expect(dataset.reduceMotion).toBeUndefined()
  })

  it('does not rewrite the attribute when the setting is unchanged', () => {
    useSettingsStore.getState().setSettings(withReduceMotion(true))
    useSettingsStore.getState().setSettings({ ...withReduceMotion(true), theme: 'light' })
    expect(writes).toBe(1)
  })

  it('applies the attribute after a successful setReduceMotion', async () => {
    stubRefract({ ok: true, value: withReduceMotion(true) })
    await useSettingsStore.getState().setReduceMotion(true)
    expect(dataset.reduceMotion).toBe('on')
  })

  it('leaves the attribute unchanged when setReduceMotion fails', async () => {
    useSettingsStore.getState().setSettings(withReduceMotion(true))
    stubRefract({ ok: false, error: { code: 'invalid-argument', message: 'nope' } })
    await useSettingsStore.getState().setReduceMotion(false)
    expect(dataset.reduceMotion).toBe('on')
  })
})
