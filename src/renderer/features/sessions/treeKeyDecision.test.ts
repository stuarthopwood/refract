// #1862 FR-009: the decision behind the tree keys is pure, so it is tested over plain Sessions with no DOM.
import { describe, expect, it, vi } from 'vitest'

// sessionDisplay.tsx (pulled in by sessionTree.ts) imports the store barrel, whose dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import type { SessionSummary } from '../../../shared/ipc'
import { buildSessionTree, flattenVisible } from './sessionTree'
import { decideConversationEntryKey, decideSessionConversationKey, decideTreeKey } from './treeKeyDecision'

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

describe('decideSessionConversationKey', () => {
  const closed = { hasChildSessions: false, listOpen: false, entryCount: 0 }
  const open = { hasChildSessions: false, listOpen: true, entryCount: 3 }

  it('expands on Right, then moves into the list, and collapses on Left', () => {
    expect(decideSessionConversationKey({ key: 'ArrowRight' }, closed)).toEqual({ prevent: true, setOpen: true, focusFirstEntry: false })
    expect(decideSessionConversationKey({ key: 'ArrowRight' }, open)).toEqual({ prevent: true, setOpen: null, focusFirstEntry: true })
    expect(decideSessionConversationKey({ key: 'ArrowLeft' }, open)).toEqual({ prevent: true, setOpen: false, focusFirstEntry: false })
    expect(decideSessionConversationKey({ key: 'ArrowLeft' }, closed).prevent).toBe(false)
  })

  it('enters the list on Down only when it is open with entries', () => {
    expect(decideSessionConversationKey({ key: 'ArrowDown' }, open)).toEqual({ prevent: true, setOpen: null, focusFirstEntry: true })
    expect(decideSessionConversationKey({ key: 'ArrowDown' }, closed).prevent).toBe(false)
    expect(decideSessionConversationKey({ key: 'ArrowDown' }, { ...open, entryCount: 0 }).prevent).toBe(false)
  })

  it('leaves plain Right and Left to child Sessions and takes them with Alt', () => {
    const parent = { ...closed, hasChildSessions: true }
    expect(decideSessionConversationKey({ key: 'ArrowRight' }, parent).prevent).toBe(false)
    expect(decideSessionConversationKey({ key: 'ArrowRight', altKey: true }, parent)).toEqual({ prevent: true, setOpen: true, focusFirstEntry: false })
  })

  it('ignores Ctrl, Meta and Shift chords so Ctrl+1 to Ctrl+9 stay Session-only', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(decideSessionConversationKey({ key: 'ArrowRight', ...mods }, closed).prevent).toBe(false)
    }
    expect(decideSessionConversationKey({ key: '1', ctrlKey: true }, closed).prevent).toBe(false)
  })
})

describe('decideConversationEntryKey', () => {
  it('steps between entries and leaves the list at both ends', () => {
    expect(decideConversationEntryKey({ key: 'ArrowDown' }, 0, 3)).toEqual({ kind: 'entry', index: 1 })
    expect(decideConversationEntryKey({ key: 'ArrowDown' }, 2, 3)).toEqual({ kind: 'next-session' })
    expect(decideConversationEntryKey({ key: 'ArrowUp' }, 1, 3)).toEqual({ kind: 'entry', index: 0 })
    expect(decideConversationEntryKey({ key: 'ArrowUp' }, 0, 3)).toEqual({ kind: 'session' })
  })

  it('jumps with Home and End and returns to the Session on Left', () => {
    expect(decideConversationEntryKey({ key: 'Home' }, 2, 3)).toEqual({ kind: 'entry', index: 0 })
    expect(decideConversationEntryKey({ key: 'End' }, 0, 3)).toEqual({ kind: 'entry', index: 2 })
    expect(decideConversationEntryKey({ key: 'ArrowLeft' }, 1, 3)).toEqual({ kind: 'session' })
  })

  it('ignores other keys and modified keys', () => {
    expect(decideConversationEntryKey({ key: 'x' }, 0, 3)).toBeNull()
    expect(decideConversationEntryKey({ key: 'ArrowDown', ctrlKey: true }, 0, 3)).toBeNull()
  })
})
