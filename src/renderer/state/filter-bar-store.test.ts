import { beforeEach, describe, expect, it } from 'vitest'
import { useFilterBarStore } from './filter-bar-store'

describe('filter bar open state (#1850)', () => {
  beforeEach(() => useFilterBarStore.setState({ open: {} }))

  it('starts closed for every view', () => {
    expect(useFilterBarStore.getState().open['issues'] ?? false).toBe(false)
  })

  it('keeps each view open or closed on its own', () => {
    useFilterBarStore.getState().setOpen('issues', true)
    expect(useFilterBarStore.getState().open).toEqual({ issues: true })
    useFilterBarStore.getState().setOpen('pull-requests', true)
    useFilterBarStore.getState().setOpen('issues', false)
    expect(useFilterBarStore.getState().open).toEqual({ issues: false, 'pull-requests': true })
  })

  it('does not publish a change when the value is unchanged', () => {
    useFilterBarStore.getState().setOpen('issues', true)
    const before = useFilterBarStore.getState().open
    useFilterBarStore.getState().setOpen('issues', true)
    expect(useFilterBarStore.getState().open).toBe(before)
  })
})
