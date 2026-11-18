// #1862 FR-009: the decision behind the tree keys is pure, so it is tested over plain Sessions with no DOM.
import { describe, expect, it, vi } from 'vitest'

// sessionDisplay.tsx (pulled in by sessionTree.ts) imports the store barrel, whose dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import type { SessionSummary } from '../../../shared/ipc'
import { buildSessionTree, flattenVisible } from './sessionTree'
import { decideTreeKey } from './treeKeyDecision'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, repositoryId: 'r1', archivedAt: null, parentSessionId: null, ...over } as SessionSummary
}

// a (parent) > b (child); c (leaf root)
const tree = buildSessionTree([session('a'), session('b', { parentSessionId: 'a' }), session('c')])

function decide(focused: string, key: string, open: ReadonlySet<string>, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const isOpen = (id: string) => open.has(id)
  return decideTreeKey(flattenVisible(tree, isOpen), focused, { key, ...mods }, isOpen)
}

describe('decideTreeKey', () => {
  it('does not prevent a key that is not a tree key', () => {
    expect(decide('a', 'x', new Set(['a']))).toEqual({ prevent: false, toggleId: null, focusId: null })
  })

  it('does not prevent a tree key held with a modifier', () => {
    expect(decide('a', 'ArrowDown', new Set(['a']), { ctrlKey: true })).toEqual({ prevent: false, toggleId: null, focusId: null })
    expect(decide('a', 'ArrowRight', new Set(), { shiftKey: true })).toEqual({ prevent: false, toggleId: null, focusId: null })
  })

  it('does not prevent a key from a row that is not visible', () => {
    expect(decide('b', 'ArrowUp', new Set())).toEqual({ prevent: false, toggleId: null, focusId: null })
  })

  it('does not prevent Right on a leaf, which has nothing to open', () => {
    expect(decide('c', 'ArrowRight', new Set())).toEqual({ prevent: false, toggleId: null, focusId: null })
  })

  it('opens a collapsed parent on Right', () => {
    expect(decide('a', 'ArrowRight', new Set())).toEqual({ prevent: true, toggleId: 'a', focusId: null })
  })

  it('moves to the first child on Right when the parent is already open, without toggling', () => {
    expect(decide('a', 'ArrowRight', new Set(['a']))).toEqual({ prevent: true, toggleId: null, focusId: 'b' })
  })

  it('collapses an open parent on Left', () => {
    expect(decide('a', 'ArrowLeft', new Set(['a']))).toEqual({ prevent: true, toggleId: 'a', focusId: null })
  })

  it('focuses the parent on Left from a child', () => {
    expect(decide('b', 'ArrowLeft', new Set(['a']))).toEqual({ prevent: true, toggleId: null, focusId: 'a' })
  })

  it('steps to the next visible row on Down and skips a collapsed parent children', () => {
    expect(decide('a', 'ArrowDown', new Set(['a']))).toEqual({ prevent: true, toggleId: null, focusId: 'b' })
    expect(decide('a', 'ArrowDown', new Set())).toEqual({ prevent: true, toggleId: null, focusId: 'c' })
  })
})
