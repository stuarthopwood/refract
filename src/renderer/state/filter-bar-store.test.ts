import { beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useFilterBarOpen, useFilterBarStore } from './filter-bar-store'

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

describe('useFilterBarOpen (#1850)', () => {
  beforeEach(() => useFilterBarStore.setState({ open: {} }))

  // `environment: 'node'` has no DOM, so the hook runs inside a server render that only captures its return value.
  function useView(viewId: string): [boolean, (next: boolean | ((open: boolean) => boolean)) => void] {
    let captured: [boolean, (next: boolean | ((open: boolean) => boolean)) => void] | undefined
    function Probe() {
      captured = useFilterBarOpen(viewId)
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    if (!captured) throw new Error('hook did not run')
    return captured
  }

  it('a_functional_updater_flips_the_current_value_both_ways', () => {
    const [, setOpen] = useView('issues')
    setOpen((open) => !open)
    expect(useFilterBarStore.getState().open).toEqual({ issues: true })
    setOpen((open) => !open)
    expect(useFilterBarStore.getState().open).toEqual({ issues: false })
  })

  it('a_boolean_sets_the_value_directly', () => {
    useView('issues')[1](true)
    expect(useFilterBarStore.getState().open).toEqual({ issues: true })
  })

  it('views_with_different_id_prefixes_do_not_share_state', () => {
    const [, setProjects] = useView('projects-a')
    const [, setOther] = useView('projects-b')
    setProjects(true)
    expect(useFilterBarStore.getState().open).toEqual({ 'projects-a': true })
    setOther((open) => !open)
    expect(useFilterBarStore.getState().open).toEqual({ 'projects-a': true, 'projects-b': true })
    setProjects(false)
    expect(useFilterBarStore.getState().open).toEqual({ 'projects-a': false, 'projects-b': true })
  })
})
