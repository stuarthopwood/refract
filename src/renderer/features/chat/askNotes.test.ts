import { describe, expect, it } from 'vitest'
import { pickedNotes } from './askNotes'

describe('pickedNotes (#1987)', () => {
  it('sends a note for each picked option that has one, in pick order', () => {
    expect(pickedNotes(['B', 'A'], { A: 'first', B: 'second' })).toEqual([
      { option: 'B', text: 'second' },
      { option: 'A', text: 'first' }
    ])
  })

  it('drops a note on an option that is not picked', () => {
    expect(pickedNotes(['A'], { A: 'kept', B: 'hidden' })).toEqual([{ option: 'A', text: 'kept' }])
  })

  it('sends nothing for a picked option without a note or with a blank one', () => {
    expect(pickedNotes(['A', 'B'], { B: '   ' })).toEqual([])
  })

  it('trims the text it sends', () => {
    expect(pickedNotes(['A'], { A: '  hi  ' })).toEqual([{ option: 'A', text: 'hi' }])
  })
})
