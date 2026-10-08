// Issue #540 (#591 cycle 3, full architectural replacement): a chip's identity, text, queue, and
// position come ONLY from the real `followUp`/`steering` arrays `queue_update` gives the
// renderer -- there is no more concept of a client-tracked "reserved"/"confirmed"/"pending" chip
// state. Reviewers proved (by reading React's own scheduling source) that the previous
// optimistic-reservation design's "read a ref, then let a later effect overwrite it" ordering was
// not a fixable bug, just an unfixable consequence of trying to keep client state in sync with
// server state the client fundamentally cannot know better than the server's own next frame.
//
// This module only solves the one real client-side problem: giving each on-screen OCCURRENCE of
// a duplicate queued text a stable identity (`key`) across renders, so React's keyed
// reconciliation never remounts a chip's DOM node just because the SAME text moved from
// `followUp` to `steering` (or vice versa) -- only a real add/remove of an occurrence changes
// which ids exist.
//
// Medium (code-reviewer, #598): ids are tracked PER TEXT AND PER QUEUE SEGMENT (`followUp` and
// `steering` each get their own array), not as one combined pool with steering occupying the
// front and follow-up the back. A single combined pool shrinking "from the front" retired
// whichever id happened to sit first -- almost always the STEERING occurrence's id -- even when
// the occurrence that actually disappeared was a FOLLOW-UP one (e.g. the user removed a
// follow-up while a same-text steering chip was still in flight). That handed the steering
// chip's node identity to the removed follow-up, remounting the wrong chip and potentially
// leaving a stale "Removing queued message" label on the chip that was actually still being
// delivered. With separate arrays, a follow-up removal only ever retires a follow-up id and a
// steering removal only ever retires a steering id.
//
// Growing/shrinking/promoting ids for a text, in this exact order, on every new snapshot:
//
// 1. PROMOTIONS: `min(max(-dF, 0), max(dS, 0))` ids move from the FRONT of that text's
//    `followUp` array to the BACK of its `steering` array (`dF`/`dS` are this text's count
//    deltas since the previous snapshot) -- this models "some follow-up occurrences were
//    promoted to steering", matching OMP's own FIFO `promote_queued_message` semantics
//    (FINDINGS item 46): whichever occurrence was queued first is the one a real promotion
//    resolves against, so its id is also the first to move.
// 2. RETIRE REMAINING DECREASES: any further decrease in `followUp` count (beyond what
//    promotions already accounted for) retires ids from the FRONT of `followUp`'s own array;
//    any further decrease in `steering` count retires ids from the FRONT of `steering`'s own
//    array. A removed follow-up occurrence therefore never retires a steering id, and vice versa.
// 3. APPEND FRESH IDS FOR REMAINING INCREASES: any remaining increase in `followUp` count
//    appends new ids to the back of `followUp`; any remaining increase in `steering` count
//    appends new ids to the back of `steering` (in practice this rarely fires for `steering`,
//    since the composer's own code only ever grows `steering` via promotion from `followUp`,
//    but it is implemented generally and correctly regardless).
//
// Known, accepted ambiguity (test-reviewer, #598): this derivation only ever sees plain
// per-text COUNT arrays, never per-occurrence provenance, so it cannot distinguish "one
// steering occurrence was delivered AND one follow-up occurrence was promoted to steering, in
// the same snapshot" from "nothing happened to this text's net counts" -- a net-zero change in
// the steering count for a text is always treated as the former (a follow-up-only
// promotion/removal), never detected as the latter. This is unavoidable given the information
// actually available here, and harmless in practice: OMP's own queue semantics make a true
// net-zero-via-independent-events outcome for a single text in one snapshot extremely rare.
// Documented here as a known, accepted edge case, not a bug to fix.
//
// `deriveQueuedChips` itself is a pure function: it never mutates `priorPool` (every returned
// collection is freshly allocated), so calling it twice in a row with the SAME arguments always
// produces the same (deep-equal) result -- safe for the component to cache in a ref and feed
// back in, including under React StrictMode's dev-only double-invoked renders, and directly
// unit-testable with no React involved at all.

import type { QueueKind } from '../../../shared/frames'

export interface DerivedChip {
  key: string
  text: string
  queue: QueueKind
}

/** Per-text id bookkeeping, split by queue segment (Medium, #598) so a follow-up occurrence's
 * removal/addition never retires or reassigns a steering occurrence's id, and vice versa. */
export interface TextIdPool {
  readonly followUp: readonly string[]
  readonly steering: readonly string[]
}

export interface ChipPoolState {
  readonly idsByText: ReadonlyMap<string, TextIdPool>
  readonly nextSeq: number
}

export const EMPTY_CHIP_POOL: ChipPoolState = { idsByText: new Map(), nextSeq: 0 }

export function deriveQueuedChips(
  followUp: readonly string[],
  steering: readonly string[],
  priorPool: ChipPoolState
): { chips: DerivedChip[]; nextPool: ChipPoolState } {
  const followUpByText = new Map<string, number>()
  for (const t of followUp) followUpByText.set(t, (followUpByText.get(t) ?? 0) + 1)
  const steeringByText = new Map<string, number>()
  for (const t of steering) steeringByText.set(t, (steeringByText.get(t) ?? 0) + 1)
  const allTexts = new Set<string>([...followUpByText.keys(), ...steeringByText.keys()])

  let seq = priorPool.nextSeq
  const idsByText = new Map<string, TextIdPool>()
  for (const text of allTexts) {
    const followUpCount = followUpByText.get(text) ?? 0
    const steeringCount = steeringByText.get(text) ?? 0
    const prior = priorPool.idsByText.get(text)
    let followUpIds = prior ? [...prior.followUp] : []
    let steeringIds = prior ? [...prior.steering] : []

    const dF = followUpCount - followUpIds.length
    const dS = steeringCount - steeringIds.length

    // 1. Promotions: move ids from the front of `followUp` to the back of `steering`.
    const promotions = Math.min(Math.max(-dF, 0), Math.max(dS, 0))
    if (promotions > 0) {
      const moved = followUpIds.slice(0, promotions)
      followUpIds = followUpIds.slice(promotions)
      steeringIds = [...steeringIds, ...moved]
    }

    // 2. Retire any remaining decrease, independently, from the front of each array.
    if (followUpIds.length > followUpCount) followUpIds = followUpIds.slice(followUpIds.length - followUpCount)
    if (steeringIds.length > steeringCount) steeringIds = steeringIds.slice(steeringIds.length - steeringCount)

    // 3. Append fresh ids for any remaining increase, independently, to the back of each array.
    while (followUpIds.length < followUpCount) followUpIds.push(`chip-${seq++}`)
    while (steeringIds.length < steeringCount) steeringIds.push(`chip-${seq++}`)

    idsByText.set(text, { followUp: followUpIds, steering: steeringIds })
  }
  // Texts with zero alive occurrences are simply not copied into the next pool (pruned).

  const chips: DerivedChip[] = []
  const followUpSeen = new Map<string, number>()
  for (const text of followUp) {
    const seen = followUpSeen.get(text) ?? 0
    followUpSeen.set(text, seen + 1)
    const key = idsByText.get(text)!.followUp[seen]!
    chips.push({ key, text, queue: 'followUp' })
  }
  const steeringSeen = new Map<string, number>()
  for (const text of steering) {
    const seen = steeringSeen.get(text) ?? 0
    steeringSeen.set(text, seen + 1)
    const key = idsByText.get(text)!.steering[seen]!
    chips.push({ key, text, queue: 'steering' })
  }

  return { chips, nextPool: { idsByText, nextSeq: seq } }
}
