import { describe, expect, it } from 'vitest'
import { chainFor, type ChainablePullRequest } from './stack-chain'

const pr = (number: number, headRef: string, baseRef: string, state: ChainablePullRequest['state'] = 'open'): ChainablePullRequest => ({
  number,
  headRef,
  baseRef,
  state
})

describe('chainFor', () => {
  const three = [pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b')]

  it('positions each layer of a three-layer stack', () => {
    expect(chainFor(three, 1)).toEqual({ position: 1, total: 3, layers: [1, 2, 3] })
    expect(chainFor(three, 2)).toEqual({ position: 2, total: 3, layers: [1, 2, 3] })
    expect(chainFor(three, 3)).toEqual({ position: 3, total: 3, layers: [1, 2, 3] })
  })

  it('returns null with no neighbour', () => {
    expect(chainFor([pr(1, 'a', 'main'), pr(2, 'x', 'main')], 1)).toBeNull()
    expect(chainFor(three, 99)).toBeNull()
  })

  it('stops at a forked base instead of guessing a child', () => {
    const forked = [pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'a')]
    expect(chainFor(forked, 1)).toBeNull()
  })

  it('keeps a merged middle layer in the chain', () => {
    const merged = [pr(1, 'a', 'main'), pr(2, 'b', 'a', 'merged'), pr(3, 'c', 'b')]
    expect(chainFor(merged, 3)?.layers).toEqual([1, 2, 3])
  })

  it('terminates on a cycle', () => {
    const cycle = [pr(1, 'a', 'b'), pr(2, 'b', 'a')]
    expect(chainFor(cycle, 1)).toEqual({ position: 2, total: 2, layers: [2, 1] })
  })
})
