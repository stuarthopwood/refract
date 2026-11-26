import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { assistantText } from '../subagents/viewModel/testFixtures'
import { reuseUnchangedTurns, splitIntoTurns } from './splitIntoTurns'

function user(id: string): TranscriptItem {
  return { kind: 'user', id, text: id, at: 1 }
}

describe('splitIntoTurns', () => {
  it('starts a turn at every user item', () => {
    const turns = splitIntoTurns([user('u1'), assistantText('a1'), user('u2'), assistantText('a2')])
    expect(turns.map((turn) => turn.items.length)).toEqual([2, 2])
    expect(turns[1]!.userItem?.id).toBe('u2')
  })

  it('gives items ahead of the first user item a leading turn with no user item', () => {
    const turns = splitIntoTurns([assistantText('a0'), user('u1')])
    expect(turns[0]!.userItem).toBeNull()
    expect(turns).toHaveLength(2)
  })
})

describe('reuseUnchangedTurns', () => {
  describe('given a later turn that grows', () => {
    const u1 = user('u1')
    const a1 = assistantText('a1')
    const u2 = user('u2')
    const previous = splitIntoTurns([u1, a1, u2])
    const next = reuseUnchangedTurns(previous, splitIntoTurns([u1, a1, u2, assistantText('a2')]))

    it('keeps the earlier turn and its items array by identity', () => {
      expect(next[0]).toBe(previous[0])
      expect(next[0]!.items).toBe(previous[0]!.items)
    })

    it('returns the fresh turn for the one that changed', () => {
      expect(next[1]).not.toBe(previous[1])
      expect(next[1]!.items).toHaveLength(2)
    })
  })

  it('replaces a turn when one of its items is replaced by a new object', () => {
    const u1 = user('u1')
    const previous = splitIntoTurns([u1, assistantText('a1')])
    const next = reuseUnchangedTurns(previous, splitIntoTurns([u1, assistantText('a1')]))
    expect(next[0]).not.toBe(previous[0])
  })

  it('returns the new turns when there are no previous ones', () => {
    const fresh = splitIntoTurns([user('u1')])
    expect(reuseUnchangedTurns([], fresh)[0]).toBe(fresh[0])
  })
})
