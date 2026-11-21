import { describe, expect, it } from 'vitest'
import { refusalMessage, refusalTone } from './checklist-refusal'

describe('refusalMessage', () => {
  it('item_changed_names_the_status_the_agent_set', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', status: 'blocked' })).toBe(
      'The agent changed this item to blocked. Tick again if you still want it.'
    )
  })

  it('item_changed_to_complete_says_it_is_already_done_instead_of_tick_again', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', status: 'complete' })).toBe('The agent already marked this item complete.')
  })

  it('item_changed_without_a_status_gives_no_tick_instruction', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw' })).toBe('The agent changed this item. Check it, then try again if you still want to.')
  })

  it('other_refusals_show_their_own_message', () => {
    expect(refusalMessage({ code: 'unknown_session', message: 'gone' })).toBe('gone')
  })
})

describe('refusalTone', () => {
  it('item_changed_is_a_notice_and_everything_else_an_error', () => {
    expect(refusalTone({ code: 'item_changed', message: 'm' })).toBe('notice')
    expect(refusalTone({ code: 'unknown_session', message: 'm' })).toBe('error')
  })
})
