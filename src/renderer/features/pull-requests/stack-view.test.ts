// Logic behind the stack UI (#1867): feature gating, position mapping, merge input and dialog copy.
import { describe, expect, it } from 'vitest'
import {
  buildStackMap,
  mergeDialogStack,
  mergeInputFor,
  mergeLayersText,
  stackFeatureOn,
  stackKey,
  stackLayerViews,
  stackPositionFor
} from './stack-view'

const REFS = [
  { number: 10, headRef: 'a', baseRef: 'main' },
  { number: 11, headRef: 'b', baseRef: 'a' },
  { number: 12, headRef: 'c', baseRef: 'b' },
  { number: 20, headRef: 'solo', baseRef: 'main' }
]

describe('stackFeatureOn', () => {
  it('needs the toggle on and gh stack ready', () => {
    expect(stackFeatureOn(true, 'ready')).toBe(true)
    expect(stackFeatureOn(false, 'ready')).toBe(false)
    expect(stackFeatureOn(true, 'missing')).toBe(false)
    expect(stackFeatureOn(true, 'outdated')).toBe(false)
    expect(stackFeatureOn(true, null)).toBe(false)
  })
})

describe('stackPositionFor', () => {
  it('maps each layer to its 1-based position, bottom first', () => {
    expect(stackPositionFor(REFS, 10)).toEqual({ position: 1, total: 3, layers: [10, 11, 12] })
    expect(stackPositionFor(REFS, 11)?.position).toBe(2)
    expect(stackPositionFor(REFS, 12)?.position).toBe(3)
  })

  it('has no position for a pull request without a neighbour or one not in the refs', () => {
    expect(stackPositionFor(REFS, 20)).toBeNull()
    expect(stackPositionFor(REFS, 99)).toBeNull()
  })
})

describe('buildStackMap', () => {
  it('chains each row against its own Project only', () => {
    const map = buildStackMap(
      [
        { repositoryId: 'r1', number: 11 },
        { repositoryId: 'r2', number: 11 }
      ],
      new Map([
        ['r1', REFS],
        ['r2', [{ number: 11, headRef: 'b', baseRef: 'main' }]]
      ])
    )
    expect(map.get(stackKey('r1', 11))?.position).toBe(2)
    expect(map.has(stackKey('r2', 11))).toBe(false)
  })

  it('leaves a row unstacked when its Project has no refs', () => {
    expect(buildStackMap([{ repositoryId: 'r1', number: 11 }], new Map()).size).toBe(0)
  })
})

describe('mergeLayersText', () => {
  it('says layers 1 to N merge together for a higher layer', () => {
    expect(mergeLayersText({ position: 3, total: 3, layers: [10, 11, 12] })).toBe('Merges layers 1 to 3 together.')
  })

  it('does not claim a group merge for the bottom layer', () => {
    expect(mergeLayersText({ position: 1, total: 3, layers: [10, 11, 12] })).toBe('Merges layer 1 of 3.')
  })
})

describe('mergeDialogStack', () => {
  const position = { position: 2, total: 3, layers: [10, 11, 12] }

  it('offers Install while gh stack cannot merge the stack', () => {
    expect(mergeDialogStack(true, 'missing', position)).toBe('install')
    expect(mergeDialogStack(true, 'outdated', position)).toBe('install')
  })

  it('shows the layers line once gh stack is ready', () => {
    expect(mergeDialogStack(true, 'ready', position)).toBe('layers')
  })

  it('stays silent for an unstacked pull request, a toggle that is off, or an unknown state', () => {
    expect(mergeDialogStack(true, 'ready', null)).toBeNull()
    expect(mergeDialogStack(false, 'missing', position)).toBeNull()
    expect(mergeDialogStack(true, null, position)).toBeNull()
  })
})

describe('mergeInputFor', () => {
  const base = { method: 'squash' as const, expectedHeadSha: 'abc', headBranch: 'b' }
  const position = { position: 2, total: 3, layers: [10, 11, 12] }

  it('sends stacked only for a stacked pull request with the feature on', () => {
    expect(mergeInputFor(base, position, true)).toEqual({ ...base, stackHint: 'stacked' })
  })

  it('sends plain when the feature is off, even for a stacked pull request', () => {
    expect(mergeInputFor(base, position, false).stackHint).toBe('plain')
  })

  it('sends plain for an unstacked pull request', () => {
    expect(mergeInputFor(base, null, true).stackHint).toBe('plain')
  })
})

describe('stackLayerViews', () => {
  const position = { position: 2, total: 3, layers: [10, 11, 12] }

  it('marks only the current layer and takes title and state from known rows', () => {
    const views = stackLayerViews(position, 11, (n) => (n === 10 ? { title: 'Base', state: 'merged' } : undefined))
    expect(views.map((v) => v.current)).toEqual([false, true, false])
    expect(views[0]).toMatchObject({ number: 10, title: 'Base', state: 'merged' })
  })

  it('shows an unknown layer as an open number only', () => {
    expect(stackLayerViews(position, 11, () => undefined)[2]).toMatchObject({ number: 12, title: null, state: 'open' })
  })
})
