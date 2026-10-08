import { describe, expect, test } from 'vitest'
import { deriveQueuedChips, EMPTY_CHIP_POOL, type ChipPoolState, type DerivedChip } from './queuedChips'

interface QueueSnapshot {
  followUp: readonly string[]
  steering: readonly string[]
}

/** Runs a sequence of `(followUp, steering)` snapshots through `deriveQueuedChips`, threading
 * `nextPool` back in as `priorPool` for the next step exactly as the component's own `useRef`
 * does, and returns every step's `chips` result for inspection. */
function runSequence(steps: readonly QueueSnapshot[]): DerivedChip[][] {
  let pool: ChipPoolState = EMPTY_CHIP_POOL
  const results: DerivedChip[][] = []
  for (const step of steps) {
    const { chips, nextPool } = deriveQueuedChips(step.followUp, step.steering, pool)
    pool = nextPool
    results.push(chips)
  }
  return results
}

describe('deriveQueuedChips', () => {
  test('click the second of [A, A]: distinct keys preserved across the real promotion', () => {
    const steps = runSequence([
      { followUp: ['A', 'A'], steering: [] },
      { followUp: ['A'], steering: ['A'] }
    ])
    const before = steps[0]!
    const after = steps[1]!
    expect(before).toHaveLength(2)
    const beforeKeys = before.map((c) => c.key)
    expect(new Set(beforeKeys).size).toBe(2) // distinct keys
    expect(before.every((c) => c.queue === 'followUp')).toBe(true)

    expect(after).toHaveLength(2)
    const afterKeys = after.map((c) => c.key)
    expect(new Set(afterKeys).size).toBe(2) // still distinct
    // No new key appears out of nowhere, none silently vanishes.
    expect(new Set(afterKeys)).toEqual(new Set(beforeKeys))
    const afterByQueue = Object.fromEntries(after.map((c) => [c.queue, c.key]))
    expect(Object.keys(afterByQueue).sort()).toEqual(['followUp', 'steering'])
  })

  test('[A, A, A] with occurrence 0 then occurrence 2 clicked: key continuity throughout', () => {
    const steps = runSequence([
      { followUp: ['A', 'A', 'A'], steering: [] },
      { followUp: ['A', 'A'], steering: ['A'] },
      { followUp: ['A'], steering: ['A', 'A'] }
    ])
    const s0 = steps[0]!
    const s1 = steps[1]!
    const s2 = steps[2]!

    expect(s0).toHaveLength(3)
    const keys0 = s0.map((c) => c.key)
    expect(new Set(keys0).size).toBe(3)

    expect(s1).toHaveLength(3)
    const keys1 = s1.map((c) => c.key)
    expect(new Set(keys1).size).toBe(3)
    expect(new Set(keys1)).toEqual(new Set(keys0)) // no orphan, no duplicate
    expect(s1.filter((c) => c.queue === 'steering')).toHaveLength(1)
    expect(s1.filter((c) => c.queue === 'followUp')).toHaveLength(2)

    expect(s2).toHaveLength(3)
    const keys2 = s2.map((c) => c.key)
    expect(new Set(keys2).size).toBe(3)
    expect(new Set(keys2)).toEqual(new Set(keys0))
    expect(s2.filter((c) => c.queue === 'steering')).toHaveLength(2)
    expect(s2.filter((c) => c.queue === 'followUp')).toHaveLength(1)
  })

  test('derivation from a (followUp, steering) pair reflecting an already-happened promotion is stable regardless of prior call history', () => {
    // The pure function has no concept of in-flight RPCs at all -- that's the component's
    // `inFlightChips` state, never this function's business. Calling it fresh (no prior calls)
    // against a snapshot that already reflects a promotion must derive the same shape (one
    // follow-up occurrence plus one steering occurrence, since this snapshot has one of each)
    // as reaching that snapshot via an intermediate step would.
    const direct = deriveQueuedChips(['A'], ['A'], EMPTY_CHIP_POOL).chips
    const steps = runSequence([
      { followUp: ['A', 'A'], steering: [] },
      { followUp: ['A'], steering: ['A'] }
    ])
    const viaIntermediate = steps[1]!
    expect(direct).toHaveLength(2)
    expect(viaIntermediate).toHaveLength(2)
    expect(direct.map((c) => c.queue).sort()).toEqual(['followUp', 'steering'])
    expect(viaIntermediate.map((c) => c.queue).sort()).toEqual(['followUp', 'steering'])
    expect(direct.every((c) => c.text === 'A')).toBe(true)
    expect(viaIntermediate.every((c) => c.text === 'A')).toBe(true)
  })

  test('delivery while idle: a steering entry disappearing retires its key without touching an unrelated follow-up', () => {
    const steps = runSequence([
      { followUp: ['B'], steering: ['A'] },
      { followUp: ['B'], steering: [] }
    ])
    const before = steps[0]!
    const after = steps[1]!
    expect(before).toHaveLength(2)
    const followUpKeyBefore = before.find((c) => c.text === 'B')!.key
    const steeringKeyBefore = before.find((c) => c.text === 'A')!.key

    expect(after).toHaveLength(1)
    expect(after[0]!.text).toBe('B')
    expect(after[0]!.queue).toBe('followUp')
    expect(after[0]!.key).toBe(followUpKeyBefore) // unaffected by the unrelated delivery
    expect(after[0]!.key).not.toBe(steeringKeyBefore) // the retired key is gone, not reused yet
  })

  test('stale-snapshot sequence from cycle 2: an earlier, fully-delivered A leaves no trace on a later unrelated pair of As', () => {
    const steps = runSequence([
      { followUp: ['A'], steering: [] },
      { followUp: [], steering: ['A'] },
      { followUp: [], steering: [] },
      { followUp: ['A', 'A'], steering: [] },
      { followUp: ['A'], steering: ['A'] }
    ])
    const s0 = steps[0]!
    const s1 = steps[1]!
    const s2 = steps[2]!
    const s3 = steps[3]!
    const s4 = steps[4]!

    expect(s0).toHaveLength(1)
    expect(s1).toHaveLength(1)
    expect(s1[0]!.queue).toBe('steering')
    expect(s2).toHaveLength(0) // fully delivered, no stale leftover chip

    expect(s3).toHaveLength(2)
    const keys3 = s3.map((c) => c.key)
    expect(new Set(keys3).size).toBe(2)
    expect(s3.every((c) => c.queue === 'followUp')).toBe(true)

    expect(s4).toHaveLength(2)
    const keys4 = s4.map((c) => c.key)
    expect(new Set(keys4).size).toBe(2)
    expect(new Set(keys4)).toEqual(new Set(keys3)) // no leak from the earlier, unrelated A
    expect(s4.filter((c) => c.queue === 'steering')).toHaveLength(1)
    expect(s4.filter((c) => c.queue === 'followUp')).toHaveLength(1)
  })
})
