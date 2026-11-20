import { describe, expect, it } from 'vitest'
import { refusalMessage } from './checklist-refusal'

describe('refusalMessage', () => {
  it('item_changed_names_the_status_the_agent_set', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', status: 'blocked' })).toBe(
      'The agent changed this item to blocked. Tick again if you still want it.'
    )
  })

  it('item_changed_without_a_status_omits_it', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw' })).toBe('The agent changed this item. Tick again if you still want it.')
  })

  it('other_refusals_show_their_own_message', () => {
    expect(refusalMessage({ code: 'unknown_session', message: 'gone' })).toBe('gone')
  })
})
