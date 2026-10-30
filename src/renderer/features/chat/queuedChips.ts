
import type { QueueKind } from '../../../shared/frames'

/** One queued-message chip with a stable key. */
export interface DerivedChip {
  key: string
  text: string
  queue: QueueKind
}

/** Per-text id lists, split by queue segment so a removal never retires the other segment's id (#598). */
export interface TextIdPool {
  readonly followUp: readonly string[]
  readonly steering: readonly string[]
}

/** Id pool carried between snapshots. */
export interface ChipPoolState {
  readonly idsByText: ReadonlyMap<string, TextIdPool>
  readonly nextSeq: number
}

/** Initial pool with no ids. */
export const EMPTY_CHIP_POOL: ChipPoolState = { idsByText: new Map(), nextSeq: 0 }

/** Pure: gives each queued-text occurrence a stable key so React never remounts a chip that only moved queue. */
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

    const promotions = Math.min(Math.max(-dF, 0), Math.max(dS, 0))
    if (promotions > 0) {
      const moved = followUpIds.slice(0, promotions)
      followUpIds = followUpIds.slice(promotions)
      steeringIds = [...steeringIds, ...moved]
    }

    if (followUpIds.length > followUpCount) followUpIds = followUpIds.slice(followUpIds.length - followUpCount)
    if (steeringIds.length > steeringCount) steeringIds = steeringIds.slice(steeringIds.length - steeringCount)

    while (followUpIds.length < followUpCount) followUpIds.push(`chip-${seq++}`)
    while (steeringIds.length < steeringCount) steeringIds.push(`chip-${seq++}`)

    idsByText.set(text, { followUp: followUpIds, steering: steeringIds })
  }

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
