// Pure rules behind the stack UI (#1867): which pull requests count as stacked, what the merge
// call is told, and the text shown. No React here so each rule is unit-tested directly.
import type { GhStackState } from '../../../shared/ipc-github-stack'
import type { PullRequestState } from '../../../shared/github'
import type { MergeInput } from '../../../shared/ipc'
import type { StackRefsResult } from '../../../shared/ipc-pull-requests'
import { chainFor, type StackPosition } from '../../../shared/stack-chain'

type StackRef = StackRefsResult['items'][number]

export function stackKey(repositoryId: string, number: number): string {
  return `${repositoryId}#${number}`
}

/** Until `gh stack` is `ready` Refract behaves as if the toggle were off (FR-012). */
export function stackFeatureOn(settingOn: boolean, state: GhStackState | null): boolean {
  return settingOn && state === 'ready'
}

/** Stack refs only list open pull requests, so every ref chains as open. */
export function stackPositionFor(refs: readonly StackRef[], number: number): StackPosition | null {
  return chainFor(
    refs.map((ref) => ({ ...ref, state: 'open' as const })),
    number
  )
}

/** Chains every row against its own Project's refs; one pass per list load, not per row render. */
export function buildStackMap(
  rows: ReadonlyArray<{ repositoryId: string; number: number }>,
  refsByRepository: ReadonlyMap<string, readonly StackRef[]>
): Map<string, StackPosition> {
  const out = new Map<string, StackPosition>()
  for (const row of rows) {
    const position = stackPositionFor(refsByRepository.get(row.repositoryId) ?? [], row.number)
    if (position) out.set(stackKey(row.repositoryId, row.number), position)
  }
  return out
}

/** The line in the Merge dialog; the bottom layer merges alone, a higher one carries the layers under it. */
export function mergeLayersText(position: StackPosition): string {
  if (position.position === 1) return `Merges layer 1 of ${position.total}.`
  return `Merges layers 1 to ${position.position} together.`
}

/**
 * What the Merge dialog says about a stack: Install while `gh stack` cannot merge it, the layers
 * line once it can, nothing for an unstacked pull request or while the toggle is off.
 */
export function mergeDialogStack(settingOn: boolean, state: GhStackState | null, position: StackPosition | null): 'install' | 'layers' | null {
  if (!settingOn || !position) return null
  if (state === 'missing' || state === 'outdated') return 'install'
  return state === 'ready' ? 'layers' : null
}

/**
 * Merge input with the stack hint. `plain` is sent whenever the feature is off, so a setting
 * turned off since the dialog opened can never route a merge through `gh stack`.
 */
export function mergeInputFor(
  base: Pick<MergeInput, 'method' | 'expectedHeadSha' | 'headBranch'>,
  position: StackPosition | null,
  featureOn: boolean
): MergeInput {
  return { ...base, stackHint: featureOn && position ? 'stacked' : 'plain' }
}

export interface StackLayerView {
  number: number
  title: string | null
  state: PullRequestState
  current: boolean
}

/** Known rows give a layer its title and state; others show as an open `#n` (refs are open-only). */
export function stackLayerViews(
  position: StackPosition,
  currentNumber: number,
  known: (number: number) => { title: string; state: PullRequestState } | undefined
): StackLayerView[] {
  return position.layers.map((number) => {
    const row = known(number)
    return { number, title: row?.title ?? null, state: row?.state ?? 'open', current: number === currentNumber }
  })
}
