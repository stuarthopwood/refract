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
  // Medium (code-reviewer/test-reviewer, #598): every assertion below pins the exact
  // `{key, text, queue}` identity of each chip, not just set membership or counts -- a
  // regression that swapped which occurrence gets which key would have passed every one of
  // this file's previous assertions, which defeated the whole point of testing identity
  // stability.
  test('click the second of [A, A]: distinct keys preserved across the real promotion', () => {
    const steps = runSequence([
      { followUp: ['A', 'A'], steering: [] },
      { followUp: ['A'], steering: ['A'] }
    ])
    const before = steps[0]!
    const after = steps[1]!
    const [k0, k1] = before.map((c) => c.key)
    expect(before).toEqual([
      { key: k0, text: 'A', queue: 'followUp' },
      { key: k1, text: 'A', queue: 'followUp' }
    ])
    // OMP's `promote_queued_message` promotes by TEXT, FIFO (FINDINGS item 46): the FIRST
    // occurrence queued (k0) is always the one a real promotion resolves against, regardless of
    // which visual occurrence the user actually clicked.
    expect(after).toEqual([
      { key: k1, text: 'A', queue: 'followUp' },
      { key: k0, text: 'A', queue: 'steering' }
    ])
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
    const [k0, k1, k2] = s0.map((c) => c.key)

    expect(s0).toEqual([
      { key: k0, text: 'A', queue: 'followUp' },
      { key: k1, text: 'A', queue: 'followUp' },
      { key: k2, text: 'A', queue: 'followUp' }
    ])
    // FIFO: the oldest surviving follow-up (k0) is the one promoted first.
    expect(s1).toEqual([
      { key: k1, text: 'A', queue: 'followUp' },
      { key: k2, text: 'A', queue: 'followUp' },
      { key: k0, text: 'A', queue: 'steering' }
    ])
    // A second promotion then takes the next-oldest surviving follow-up (k1).
    expect(s2).toEqual([
      { key: k2, text: 'A', queue: 'followUp' },
      { key: k0, text: 'A', queue: 'steering' },
      { key: k1, text: 'A', queue: 'steering' }
    ])
  })

  test('derivation from a (followUp, steering) pair reflecting an already-happened promotion is stable regardless of prior call history', () => {
    // The pure function has no concept of in-flight RPCs at all -- that's the component's
    // `inFlightChips` state, never this function's business. Calling it fresh (no prior calls)
    // against a snapshot that already reflects a promotion must derive the same shape (one
    // follow-up occurrence plus one steering occurrence, since this snapshot has one of each)
    // as reaching that snapshot via an intermediate step would -- each path is internally
    // consistent even though the two paths don't assign the SAME literal keys to each other.
    const direct = deriveQueuedChips(['A'], ['A'], EMPTY_CHIP_POOL).chips
    expect(direct).toEqual([
      { key: 'chip-0', text: 'A', queue: 'followUp' },
      { key: 'chip-1', text: 'A', queue: 'steering' }
    ])
    const steps = runSequence([
      { followUp: ['A', 'A'], steering: [] },
      { followUp: ['A'], steering: ['A'] }
    ])
    const viaIntermediate = steps[1]!
    expect(viaIntermediate).toEqual([
      { key: 'chip-1', text: 'A', queue: 'followUp' },
      { key: 'chip-0', text: 'A', queue: 'steering' }
    ])
  })

  test('delivery while idle: a steering entry disappearing retires its key without touching an unrelated follow-up', () => {
    const steps = runSequence([
      { followUp: ['B'], steering: ['A'] },
      { followUp: ['B'], steering: [] }
    ])
    const before = steps[0]!
    const after = steps[1]!
    const followUpKeyBefore = before.find((c) => c.text === 'B')!.key
    const steeringKeyBefore = before.find((c) => c.text === 'A')!.key

    expect(after).toEqual([{ key: followUpKeyBefore, text: 'B', queue: 'followUp' }])
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
    const deliveredKey = s0[0]!.key

    expect(s0).toEqual([{ key: deliveredKey, text: 'A', queue: 'followUp' }])
    expect(s1).toEqual([{ key: deliveredKey, text: 'A', queue: 'steering' }])
    expect(s2).toEqual([]) // fully delivered, no stale leftover chip

    const [k3a, k3b] = s3.map((c) => c.key)
    expect(s3).toEqual([
      { key: k3a, text: 'A', queue: 'followUp' },
      { key: k3b, text: 'A', queue: 'followUp' }
    ])
    // The fully-delivered A's old key must never resurface on this later, unrelated pair.
    expect(s3.map((c) => c.key)).not.toContain(deliveredKey)

    expect(s4).toEqual([
      { key: k3b, text: 'A', queue: 'followUp' },
      { key: k3a, text: 'A', queue: 'steering' }
    ])
  })

  // Medium (code-reviewer, #598): regression coverage for the id-pool bug this PR fixes --
  // shrinking a single combined per-text pool "from the front" retired the STEERING
  // occurrence's id whenever a FOLLOW-UP occurrence of the same text was the one removed
  // (steering always sat at the front of the old combined pool), remounting the wrong chip.
  // With ids tracked per text AND per queue segment, a follow-up removal must only ever retire
  // a follow-up id -- the steering occurrence's key is untouched.
  test('MEDIUM-1 regression: removing a follow-up occurrence leaves a same-text steering occurrence\'s key unchanged', () => {
    const before = deriveQueuedChips(['A'], ['A'], EMPTY_CHIP_POOL)
    const steeringKeyBefore = before.chips.find((c) => c.queue === 'steering')!.key

    const after = deriveQueuedChips([], ['A'], before.nextPool).chips
    expect(after).toEqual([{ key: steeringKeyBefore, text: 'A', queue: 'steering' }])
  })

  test('MEDIUM-1 symmetric growth: a new follow-up A queued alongside an existing (followUp, steering) pair preserves both original keys and appends a fresh third', () => {
    const before = deriveQueuedChips(['A'], ['A'], EMPTY_CHIP_POOL)
    const followUpKeyBefore = before.chips.find((c) => c.queue === 'followUp')!.key
    const steeringKeyBefore = before.chips.find((c) => c.queue === 'steering')!.key

    const after = deriveQueuedChips(['A', 'A'], ['A'], before.nextPool).chips
    expect(after).toHaveLength(3)
    const freshKey = after.find((c) => c.queue === 'followUp' && c.key !== followUpKeyBefore)!.key
    expect(new Set([followUpKeyBefore, steeringKeyBefore, freshKey]).size).toBe(3) // all distinct
    expect(after).toEqual([
      { key: followUpKeyBefore, text: 'A', queue: 'followUp' },
      { key: freshKey, text: 'A', queue: 'followUp' },
      { key: steeringKeyBefore, text: 'A', queue: 'steering' }
    ])
  })
})
