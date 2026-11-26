import { describe, expect, it } from 'vitest'
import type { UsageBreakdownRow } from '../../shared/ipc-usage'
import { mergeProjects } from './usage-store'

const totals = { calls: 1, tokens: 1, usd: 1, credits: 1 }
const row = (id: string, label: string): UsageBreakdownRow => ({ id, label, ...totals })

describe('usage Project filter options', () => {
  it('lists each Project by id and name', () => {
    expect(mergeProjects([], [row('r-1', 'Refract'), row('@personal', 'Personal')], null)).toEqual([
      { id: '@personal', name: 'Personal' },
      { id: 'r-1', name: 'Refract' }
    ])
  })

  it('shows a renamed Project once, under its new name', () => {
    const before = mergeProjects([], [row('r-1', 'Refract')], null)
    expect(mergeProjects(before, [row('r-1', 'Pinion')], null)).toEqual([{ id: 'r-1', name: 'Pinion' }])
  })

  it('keeps a Project that is absent from the current rows, so a chosen filter never empties its own picker', () => {
    const before = mergeProjects([], [row('r-1', 'Refract')], null)
    expect(mergeProjects(before, [], 'r-1')).toEqual([{ id: 'r-1', name: 'Refract' }])
  })

  it('falls back to the id for a chosen Project nobody has named yet', () => {
    expect(mergeProjects([], [], 'r-9')).toEqual([{ id: 'r-9', name: 'r-9' }])
  })

  it('ignores rows without an id', () => {
    expect(mergeProjects([], [{ label: 'x', ...totals }], null)).toEqual([])
  })
})
