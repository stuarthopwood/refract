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
// which ids exist. Ids grow from the back (a newly queued duplicate gets a fresh id) and shrink
// from the front (the OLDEST occurrence's id is retired first), matching OMP's own FIFO "first
// matching follow-up" `promote_queued_message` semantics (FINDINGS item 46): whichever occurrence
// was queued first is the one a real promotion resolves against, so its id is also the first to
// be retired when the alive count for that text shrinks.
//
// `deriveQueuedChips` itself is a pure function: it never mutates `priorPool` (every returned
// collection is freshly allocated), so calling it twice in a row with the SAME arguments always
// produces the same (deep-equal) result -- safe for the component to cache in a `useRef` and feed
// back in, including under React StrictMode's dev-only double-invoked renders, and directly
// unit-testable with no React involved at all.

import type { QueueKind } from '../../../shared/frames'

export interface DerivedChip {
  key: string
  text: string
  queue: QueueKind
}

export interface ChipPoolState {
  readonly idsByText: ReadonlyMap<string, readonly string[]>
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
  const idsByText = new Map<string, readonly string[]>()
  for (const text of allTexts) {
    const followUpCount = followUpByText.get(text) ?? 0
    const steeringCount = steeringByText.get(text) ?? 0
    const aliveCount = followUpCount + steeringCount
    let ids = priorPool.idsByText.get(text) ?? []
    if (ids.length < aliveCount) {
      // Grow from the back: a newly queued duplicate occurrence gets a fresh id, never reusing
      // or reordering one already assigned to an existing occurrence.
      const grown = [...ids]
      while (grown.length < aliveCount) grown.push(`chip-${seq++}`)
      ids = grown
    } else if (ids.length > aliveCount) {
      // Shrink from the front: the OLDEST occurrence's id is retired first, matching OMP's own
      // FIFO promotion/delivery order, so a surviving duplicate's id never changes meaning.
      ids = ids.slice(ids.length - aliveCount)
    }
    idsByText.set(text, ids)
  }
  // Texts with zero alive occurrences are simply not copied into the next pool (pruned).

  const chips: DerivedChip[] = []
  const followUpSeen = new Map<string, number>()
  for (const text of followUp) {
    const ids = idsByText.get(text)!
    const steeringCount = steeringByText.get(text) ?? 0
    const seen = followUpSeen.get(text) ?? 0
    followUpSeen.set(text, seen + 1)
    // Follow-up occurrences claim ids AFTER the steering occurrences for the same text (steering
    // entries are always the oldest surviving ones), so a follow-up's id position never collides
    // with a steering occurrence's.
    const key = ids[steeringCount + seen]!
    chips.push({ key, text, queue: 'followUp' })
  }
  const steeringSeen = new Map<string, number>()
  for (const text of steering) {
    const ids = idsByText.get(text)!
    const seen = steeringSeen.get(text) ?? 0
    steeringSeen.set(text, seen + 1)
    chips.push({ key: ids[seen]!, text, queue: 'steering' })
  }

  return { chips, nextPool: { idsByText, nextSeq: seq } }
}
