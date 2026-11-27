import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageProjectOption } from '../../shared/ipc-usage'
import { projectLabels } from './usage-projects'
import { useUsageStore } from './usage-store'

const project = (id: string, name: string, removed = false): UsageProjectOption => ({ id, name, removed })

describe('usage Project picker labels', () => {
  it('shows each Project by its name, never its id', () => {
    const labels = projectLabels([project('r-1', 'Refract'), project('@personal', 'Personal')])
    expect([...labels.values()]).toEqual(['Refract', 'Personal'])
  })

  it('tells two Projects with one name apart by "(removed)", not by id', () => {
    const labels = projectLabels([project('r-1', 'Refract'), project('r-old', 'Refract', true)])
    expect(labels.get('r-1')).toBe('Refract')
    expect(labels.get('r-old')).toBe('Refract (removed)')
  })

  it('numbers duplicates that are still identical after the qualifier', () => {
    const labels = projectLabels([project('a', 'Refract', true), project('b', 'Refract', true)])
    expect(labels.get('a')).toBe('Refract (removed)')
    expect(labels.get('b')).toBe('Refract (removed) (2)')
  })
})

describe('usage filters stay in memory (#1850)', () => {
  const getPrefs = vi.fn()
  const projects = vi.fn()
  const setPrefs = vi.fn()
  const emptyOk = { ok: true, value: [] }

  beforeEach(() => {
    const api = {
      getPrefs,
      projects,
      setPrefs,
      summary: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }),
      timeseries: vi.fn().mockResolvedValue(emptyOk),
      tokenMix: vi.fn().mockResolvedValue(emptyOk),
      breakdown: vi.fn().mockResolvedValue(emptyOk),
      errorCategories: vi.fn().mockResolvedValue(emptyOk),
      topSessions: vi.fn().mockResolvedValue(emptyOk),
      calls: vi.fn().mockResolvedValue({ ok: true, value: { rows: [], total: 0 } }),
      frustration: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }),
      budget: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } })
    }
    vi.stubGlobal('window', { refract: { usage: api } })
    useUsageStore.setState({ prefsLoaded: false, filters: { range: '7d' } })
    setPrefs.mockReset().mockResolvedValue({ ok: true, value: { jokes: true } })
    projects.mockResolvedValue({ ok: true, value: [project('r-1', 'Refract')] })
  })

  it('ignores filters saved on disk by an earlier version and keeps the Jokes preference', async () => {
    getPrefs.mockResolvedValue({ ok: true, value: { jokes: false, filters: { range: '30d', project: 'r-1' } } })

    await useUsageStore.getState().loadPrefs()

    expect(useUsageStore.getState().filters).toEqual({ range: '7d' })
    expect(useUsageStore.getState().jokes).toBe(false)
    expect(useUsageStore.getState().options.projects).toEqual([project('r-1', 'Refract')])
    expect(setPrefs).not.toHaveBeenCalled()
  })

  it('keeps a changed filter in memory without writing it to disk', () => {
    useUsageStore.getState().setFilters({ range: '30d', project: 'r-1' })

    expect(useUsageStore.getState().filters).toEqual({ range: '30d', project: 'r-1' })
    expect(setPrefs).not.toHaveBeenCalled()
  })

  it('still persists the Jokes preference', async () => {
    await useUsageStore.getState().setJokes(false)

    expect(setPrefs).toHaveBeenCalledWith({ jokes: false })
  })
})
