import { describe, expect, it } from 'vitest'
import { toActivityPending } from './toActivityPending'

describe('toActivityPending', () => {
  it('Given a whole-form request, When reduced, Then the needs-you line names a fixed Form label', () => {
    expect(toActivityPending({ kind: 'form', requestId: 'r1', html: '<input name="a">' })).toEqual({ kind: 'question', text: 'Form' })
  })

  it('Given a question request, When reduced, Then its title is the text', () => {
    expect(toActivityPending({ kind: 'question', requestId: 'r2', title: 'Pick one', options: [], inputKind: 'choice' })).toEqual({ kind: 'question', text: 'Pick one' })
  })

  it('Given an ask batch, When reduced, Then the first question is the text, or null when empty', () => {
    const question = { id: 'q', question: 'Which?', options: [], multi: false }
    expect(toActivityPending({ kind: 'ask', requestId: 'r3', questions: [question] })).toEqual({ kind: 'question', text: 'Which?' })
    expect(toActivityPending({ kind: 'ask', requestId: 'r4', questions: [] })).toBeNull()
  })

  it('Given no request, When reduced, Then null', () => {
    expect(toActivityPending(undefined)).toBeNull()
  })
})
