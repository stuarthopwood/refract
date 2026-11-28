import { describe, expect, it } from 'vitest'
import { numberSessionStages, numberStages, reuseStageNumbers } from './numbering'

describe('numberStages', () => {
  it('numbers keys from 1 in the order given', () => {
    expect([...numberStages(['a', 'b', 'c'])]).toEqual([['a', 1], ['b', 2], ['c', 3]])
  })

  it('keeps the first number of a key seen again', () => {
    expect(numberStages(['a', 'b', 'a', 'c']).get('c')).toBe(3)
  })

  it('never hands a number out twice, however many keys repeat', () => {
    const numbers = [...numberStages(['a', 'a', 'b', 'b']).values()]
    expect(new Set(numbers).size).toBe(numbers.length)
  })
})

describe('numberSessionStages', () => {
  it('numbers transcript items first and then summaries the transcript lacks', () => {
    const numbers = numberSessionStages([{ toolCallId: 'c1' }, { toolCallId: 'c2' }], [{ toolCallId: 'c3' }, { toolCallId: 'c1' }])
    expect([...numbers]).toEqual([['c1', 1], ['c2', 2], ['c3', 3]])
  })
})

describe('reuseStageNumbers', () => {
  it('returns the previous map when the numbers are the same', () => {
    const previous = numberStages(['a', 'b'])
    expect(reuseStageNumbers(previous, numberStages(['a', 'b']))).toBe(previous)
  })

  it('returns the new map when a number was added', () => {
    const next = numberStages(['a', 'b', 'c'])
    expect(reuseStageNumbers(numberStages(['a', 'b']), next)).toBe(next)
  })

  it('returns the new map when the sizes match but a number differs', () => {
    // Mutation: compare sizes only.
    const next = numberStages(['b', 'a'])
    expect(reuseStageNumbers(numberStages(['a', 'b']), next)).toBe(next)
  })

  it('returns the new map when there is no previous one', () => {
    // Mutation: dereference `previous` without a guard.
    const next = numberStages(['a'])
    expect(reuseStageNumbers(undefined, next)).toBe(next)
  })

  it('numbers two calls of one message as one Stage', () => {
    // Mutation: key Stages by the launching call.
    const numbers = numberSessionStages(
      [{ toolCallId: 'c1', messageId: 'm1' }, { toolCallId: 'c2', messageId: 'm1' }, { toolCallId: 'c3', messageId: 'm2' }],
      [{ toolCallId: 'c2', stageKey: 'm1' }]
    )
    expect([...numbers]).toEqual([['m1', 1], ['m2', 2]])
  })
})
