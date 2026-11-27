// FR-180: one freshness rule for the Pull requests and Issues lists.
import { describe, expect, it } from 'vitest'
import { effectiveProjectIds, isFresh, LIST_FRESH_MS, listKey } from './list-freshness'

const base = { tab: 'all', state: 'open', projectIds: ['a', 'b'], query: '' }

describe('list key', () => {
  it('is_the_same_for_the_same_filters_whatever_the_project_order', () => {
    expect(listKey({ ...base, projectIds: ['b', 'a'] })).toBe(listKey(base))
  })

  it('changes_with_the_tab_state_projects_query_and_labels', () => {
    const key = listKey(base)
    expect(listKey({ ...base, tab: 'authored' })).not.toBe(key)
    expect(listKey({ ...base, state: 'closed' })).not.toBe(key)
    expect(listKey({ ...base, projectIds: ['a'] })).not.toBe(key)
    expect(listKey({ ...base, query: 'bug' })).not.toBe(key)
    expect(listKey({ ...base, labels: ['p1'] })).not.toBe(key)
  })

  it('ignores_whitespace_around_the_query', () => {
    expect(listKey({ ...base, query: '  bug ' })).toBe(listKey({ ...base, query: 'bug' }))
  })
})

describe('isFresh', () => {
  const key = listKey(base)

  it('is_fresh_for_the_same_key_under_a_minute_old', () => {
    expect(isFresh({ key, atMs: 1000 }, key, 1000 + LIST_FRESH_MS - 1)).toBe(true)
  })

  it('is_stale_at_a_minute_and_beyond', () => {
    expect(isFresh({ key, atMs: 1000 }, key, 1000 + LIST_FRESH_MS)).toBe(false)
  })

  it('is_stale_for_a_different_key_or_when_nothing_was_fetched', () => {
    expect(isFresh({ key, atMs: 1000 }, listKey({ ...base, state: 'all' }), 1001)).toBe(false)
    expect(isFresh(null, key, 1001)).toBe(false)
  })
})

describe('effectiveProjectIds', () => {
  it('uses_every_project_when_none_is_chosen', () => {
    expect(effectiveProjectIds([], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('drops_chosen_projects_that_are_no_longer_added', () => {
    expect(effectiveProjectIds(['a', 'gone'], ['a', 'b'])).toEqual(['a'])
  })
})
