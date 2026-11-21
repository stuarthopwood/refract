import { describe, expect, it } from 'vitest'
import type { MessageSource, TranscriptItem } from '../../../shared/model'
import { userTurnText } from './userTurnText'

type UserItem = Extract<TranscriptItem, { kind: 'user' }>

const turn = (text: string, source?: MessageSource): Pick<UserItem, 'text' | 'source'> => ({ text, ...(source ? { source } : {}) })
const checklist = (action: 'ask' | 'value' | 'complete'): MessageSource => ({ kind: 'checklist-item', checklistId: 'p1', itemId: 'i1', action })

describe('userTurnText', () => {
  it('says_what_a_complete_click_did_even_when_the_stored_text_is_not_empty', () => {
    expect(userTurnText(turn('The developer asks you to do this step yourself.\n> Run it', checklist('complete')))).toBe('Asked the agent to complete this step')
  })

  it('keeps_the_words_of_ask_and_value_turns', () => {
    expect(userTurnText(turn('Is this safe?', checklist('ask')))).toBe('Is this safe?')
    expect(userTurnText(turn('42', checklist('value')))).toBe('42')
  })

  it('keeps_the_text_of_ordinary_and_other_sourced_turns', () => {
    expect(userTurnText(turn('hello'))).toBe('hello')
    expect(userTurnText(turn('hi', { kind: 'handoff' }))).toBe('hi')
  })
})
