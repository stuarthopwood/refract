import { describe, expect, it } from 'vitest'
import { refusalMessage, refusalTone } from './checklist-refusal'

describe('refusalMessage', () => {
  it('item_changed_on_tick_names_the_status_and_says_tick_again', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', op: 'tick', status: 'blocked' })).toBe(
      'The agent changed this item to blocked. Tick again if you still want it.'
    )
  })

  it('item_changed_on_untick_names_the_status_and_says_untick_again', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', op: 'untick', status: 'complete' })).toBe(
      'The agent changed this item to complete. Untick again if you still want it.'
    )
  })

  it('tick_refused_because_the_agent_already_completed_it_says_so', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', op: 'tick', status: 'complete' })).toBe('The agent already marked this item complete.')
  })

  it('untick_refused_because_the_agent_already_reopened_it_says_so', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', op: 'untick', status: 'next' })).toBe('The agent already reopened this item.')
  })

  it('item_changed_without_a_status_gives_no_tick_instruction', () => {
    expect(refusalMessage({ code: 'item_changed', message: 'raw', op: 'tick' })).toBe('The agent changed this item. Check it, then try again if you still want to.')
  })

  it('other_refusals_show_their_own_message', () => {
    expect(refusalMessage({ code: 'unknown_session', message: 'gone', op: 'tick' })).toBe('gone')
  })
})

describe('refusalTone', () => {
  it('item_changed_is_a_notice_and_everything_else_an_error', () => {
    expect(refusalTone({ code: 'item_changed', message: 'm', op: 'tick' })).toBe('notice')
    expect(refusalTone({ code: 'unknown_session', message: 'm', op: 'tick' })).toBe('error')
  })
})
