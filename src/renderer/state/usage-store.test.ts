import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageFilters, UsageProjectOption } from '../../shared/ipc-usage'
import { projectLabels, withKnownProject } from './usage-projects'
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

describe('usage saved Project filter', () => {
  const filters: UsageFilters = { range: '7d', project: 'r-9' }

  it('drops a Project that is not a known id', () => {
    expect(withKnownProject(filters, [project('r-1', 'Refract')])).toEqual({ range: '7d', project: null })
  })

  it('keeps a known Project', () => {
    expect(withKnownProject(filters, [project('r-9', 'Pinion')])).toBe(filters)
  })
})

describe('usage store loadPrefs', () => {
  const getPrefs = vi.fn()
  const projects = vi.fn()
  const setPrefs = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('window', { refract: { usage: { getPrefs, projects, setPrefs } } })
    useUsageStore.setState({ prefsLoaded: false, filters: { range: '7d' } })
    setPrefs.mockResolvedValue({ ok: true })
  })

  it('drops a saved Project filter whose id has no name, and persists the cleared filter', async () => {
    getPrefs.mockResolvedValue({ ok: true, value: { jokes: true, filters: { range: '7d', project: 'Refract' } } })
    projects.mockResolvedValue({ ok: true, value: [project('r-1', 'Refract')] })

    await useUsageStore.getState().loadPrefs()

    expect(useUsageStore.getState().filters.project).toBeNull()
    expect(setPrefs).toHaveBeenCalledWith({ filters: { range: '7d', project: null } })
  })

  it('keeps a saved Project filter whose id is known', async () => {
    getPrefs.mockResolvedValue({ ok: true, value: { jokes: true, filters: { range: '7d', project: 'r-1' } } })
    projects.mockResolvedValue({ ok: true, value: [project('r-1', 'Refract')] })

    await useUsageStore.getState().loadPrefs()

    expect(useUsageStore.getState().filters.project).toBe('r-1')
    expect(useUsageStore.getState().options.projects).toEqual([project('r-1', 'Refract')])
  })
})
