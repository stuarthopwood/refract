// #1862: the tree builder, roll-up, "from" lookup, archive set and tree keys are pure, so they are
// tested over plain Session fixtures with no DOM.
import { describe, expect, it, vi } from 'vitest'

// sessionDisplay.tsx (home of `isNeedsYouSession` and `isRunning`) imports the store barrel, whose dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import type { SessionSummary } from '../../../shared/ipc'
import {
  buildSessionTree,
  flattenVisible,
  fromLabel,
  fromLabelText,
  liveDescendants,
  rollUp,
  rollUpLabel,
  subtreeContains,
  treeKeyMove,
  type SessionTreeNode,
} from './sessionTree'
import { isRunning } from './sessionDisplay'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: 'project',
    id,
    name: `Session ${id}`,
    repositoryId: 'r1',
    branch: `b-${id}`,
    baseBranch: 'main',
    worktreePath: `/w/${id}`,
    sessionDir: null,
    currentConversation: null,
    lastMessageCount: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    status: 'idle',
    unread: false,
    launchedMode: 'ask',
    pendingMode: null,
    ...over,
  } as SessionSummary
}

const ids = (nodes: readonly SessionTreeNode[]) => nodes.map((n) => n.session.id)
const open = () => true

describe('buildSessionTree', () => {
  it('nests a child under its parent in input order with true levels and positions', () => {
    const tree = buildSessionTree([
      session('a'),
      session('b', { parentSessionId: 'a' }),
      session('c', { parentSessionId: 'a' }),
      session('d', { parentSessionId: 'b' }),
      session('e'),
    ])
    expect(ids(tree)).toEqual(['a', 'e'])
    const [a] = tree
    expect(ids(a!.children)).toEqual(['b', 'c'])
    expect(a!.children.map((n) => [n.level, n.posInSet, n.setSize])).toEqual([
      [2, 1, 2],
      [2, 2, 2],
    ])
    expect(a!.children[0]!.children[0]).toMatchObject({ level: 3, parentId: 'b', posInSet: 1, setSize: 1 })
    expect(tree.map((n) => [n.level, n.posInSet, n.setSize])).toEqual([
      [1, 1, 2],
      [1, 2, 2],
    ])
  })

  it('puts a Session whose parent is not in the list at the top level', () => {
    expect(ids(buildSessionTree([session('a', { parentSessionId: 'gone' })]))).toEqual(['a'])
  })

  it('puts a Session that names itself as parent at the top level', () => {
    expect(ids(buildSessionTree([session('a', { parentSessionId: 'a' })]))).toEqual(['a'])
  })

  it('breaks a two-Session cycle so both still appear exactly once', () => {
    const tree = buildSessionTree([session('a', { parentSessionId: 'b' }), session('b', { parentSessionId: 'a' })])
    expect(ids(tree)).toEqual(['a', 'b'])
    expect(ids(flattenVisible(tree, open))).toEqual(['a', 'b'])
  })

  it('keeps a Session that hangs off a cycle in the tree', () => {
    const tree = buildSessionTree([
      session('a', { parentSessionId: 'b' }),
      session('b', { parentSessionId: 'a' }),
      session('c', { parentSessionId: 'a' }),
    ])
    expect(ids(flattenVisible(tree, open)).sort()).toEqual(['a', 'b', 'c'])
  })

  it('puts a Session whose parent is in another Project at the top level', () => {
    const tree = buildSessionTree([session('a', { repositoryId: 'r1' }), session('b', { repositoryId: 'r2', parentSessionId: 'a' })])
    expect(ids(tree)).toEqual(['a', 'b'])
  })

  it('puts a Session whose parent is archived at the top level', () => {
    const tree = buildSessionTree([session('a', { archivedAt: '2026-01-02T00:00:00Z' }), session('b', { parentSessionId: 'a' })])
    expect(ids(tree)).toEqual(['a', 'b'])
  })

  it('clamps the indent at level 4 while aria-level stays true', () => {
    const chain = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i, all) => session(id, i === 0 ? {} : { parentSessionId: all[i - 1] }))
    const rows = flattenVisible(buildSessionTree(chain), open)
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rows.map((r) => r.indentLevel)).toEqual([1, 2, 3, 4, 4, 4])
  })
})

describe('a tree built from a filtered list', () => {
  const all = [session('p'), session('c1', { parentSessionId: 'p' }), session('c2', { parentSessionId: 'p' }), session('g', { parentSessionId: 'c1' })]
  const byId = new Map(all.map((s) => [s.id, s]))

  it('shows a match whose parent is filtered out at the top level, still naming its parent', () => {
    const filtered = all.filter((s) => s.id === 'c1' || s.id === 'g')
    const tree = buildSessionTree(filtered)
    expect(ids(tree)).toEqual(['c1'])
    expect(tree[0]).toMatchObject({ level: 1, parentId: null })
    expect(fromLabel(tree[0]!.session, byId)).toEqual({ name: 'Session p', suffix: null })
    expect(ids(tree[0]!.children)).toEqual(['g'])
  })

  it('lists only the matches, with a lone orphan match as a plain root', () => {
    const tree = buildSessionTree(all.filter((s) => s.id === 'c2'))
    expect(ids(flattenVisible(tree, open))).toEqual(['c2'])
    expect(tree[0]!.children).toEqual([])
    expect(fromLabel(tree[0]!.session, byId)).not.toBeNull()
  })

  it('keeps the parent and child nested when both match', () => {
    const tree = buildSessionTree(all.filter((s) => s.id !== 'g'))
    expect(ids(tree)).toEqual(['p'])
    expect(ids(tree[0]!.children)).toEqual(['c1', 'c2'])
    expect(tree[0]!.children.map((n) => n.setSize)).toEqual([2, 2])
  })

  it('counts only the children that match', () => {
    const tree = buildSessionTree(all.filter((s) => s.id !== 'c2'))
    expect(ids(tree[0]!.children)).toEqual(['c1'])
    expect(tree[0]!.children[0]!.setSize).toBe(1)
  })
})

describe('flattenVisible and subtreeContains', () => {
  const tree = buildSessionTree([session('a'), session('b', { parentSessionId: 'a' }), session('c', { parentSessionId: 'b' }), session('d')])

  it('lists every row while open and drops a collapsed parent’s descendants', () => {
    expect(ids(flattenVisible(tree, open))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(flattenVisible(tree, (id) => id !== 'a'))).toEqual(['a', 'd'])
    expect(ids(flattenVisible(tree, (id) => id !== 'b'))).toEqual(['a', 'b', 'd'])
  })

  it('finds a selected Session at any depth below a parent', () => {
    expect(subtreeContains(tree[0]!, 'c')).toBe(true)
    expect(subtreeContains(tree[0]!, 'a')).toBe(true)
    expect(subtreeContains(tree[0]!, 'd')).toBe(false)
  })
})

describe('rollUp', () => {
  const tree = buildSessionTree([
    session('p'),
    session('c1', { parentSessionId: 'p', status: 'needs-you' }),
    session('c2', { parentSessionId: 'p' }),
    session('g1', { parentSessionId: 'c2', status: 'needs-you' }),
  ])

  it('counts direct children but needs-you at every depth', () => {
    expect(rollUp(tree[0]!)).toEqual({ children: 2, needsYou: 2 })
  })

  it('reads attention first only while collapsed, with singular and plural text', () => {
    expect(rollUpLabel({ children: 2, needsYou: 2 }, true)).toBe('2 need you, 2 children')
    expect(rollUpLabel({ children: 3, needsYou: 1 }, true)).toBe('1 needs you, 3 children')
    expect(rollUpLabel({ children: 2, needsYou: 2 }, false)).toBe('2 children')
    expect(rollUpLabel({ children: 1, needsYou: 0 }, true)).toBe('1 child')
  })

  it('does not count a hidden needs-you child', () => {
    const hidden = buildSessionTree([session('p'), session('c', { parentSessionId: 'p', status: 'needs-you', hiddenAt: '2026-01-02T00:00:00Z' })])
    expect(rollUp(hidden[0]!)).toEqual({ children: 1, needsYou: 0 })
  })
})

describe('fromLabel', () => {
  const byId = new Map(
    [
      session('live'),
      session('arch', { archivedAt: '2026-01-02T00:00:00Z' }),
      session('hid', { hiddenAt: '2026-01-02T00:00:00Z' }),
    ].map((s) => [s.id, s]),
  )

  it('is null for a root Session and for an unknown parent', () => {
    expect(fromLabel(session('x'), byId)).toBeNull()
    expect(fromLabel(session('x', { parentSessionId: 'gone' }), byId)).toBeNull()
  })

  it('names a live parent with no suffix', () => {
    const label = fromLabel(session('x', { parentSessionId: 'live' }), byId)!
    expect(label).toEqual({ name: 'Session live', suffix: null })
    expect(fromLabelText(label)).toBe('from Session live')
  })

  it('adds (archived) or (hidden) after the name', () => {
    expect(fromLabelText(fromLabel(session('x', { parentSessionId: 'arch' }), byId)!)).toBe('from Session arch (archived)')
    expect(fromLabelText(fromLabel(session('x', { parentSessionId: 'hid' }), byId)!)).toBe('from Session hid (hidden)')
  })
})

describe('liveDescendants', () => {
  const all = [
    session('a'),
    session('b', { parentSessionId: 'a' }),
    session('c', { parentSessionId: 'b' }),
    session('d', { parentSessionId: 'c' }),
    session('x', { parentSessionId: 'b', archivedAt: '2026-01-02T00:00:00Z' }),
    session('y', { parentSessionId: 'x' }),
    session('other'),
  ]

  it('reaches depth 3 and below, skips archived ones, and walks through them', () => {
    expect(
      liveDescendants(all, 'a')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['b', 'c', 'd', 'y'])
  })

  it('is empty for a leaf and never includes the Session itself', () => {
    expect(liveDescendants(all, 'd')).toEqual([])
    expect(liveDescendants(all, 'a').some((s) => s.id === 'a')).toBe(false)
  })

  it('terminates on a cycle', () => {
    const loop = [session('a', { parentSessionId: 'b' }), session('b', { parentSessionId: 'a' })]
    expect(liveDescendants(loop, 'a').map((s) => s.id)).toEqual(['b'])
  })
})

describe('isRunning', () => {
  it('is true for every status except stopped', () => {
    expect(isRunning({ status: 'working' })).toBe(true)
    expect(isRunning({ status: 'idle' })).toBe(true)
    expect(isRunning({ status: 'needs-you' })).toBe(true)
    expect(isRunning({ status: 'stopped' })).toBe(false)
  })
})

describe('treeKeyMove', () => {
  const tree = buildSessionTree([session('a'), session('b', { parentSessionId: 'a' }), session('c', { parentSessionId: 'b' }), session('d'), session('e', { parentSessionId: 'd' })])
  const rows = flattenVisible(tree, open)
  const key = (focused: string, k: string, isOpen: (id: string) => boolean = open, mods: Record<string, boolean> = {}) =>
    treeKeyMove(flattenVisible(tree, isOpen), focused, { key: k, ...mods }, isOpen)

  it('moves Down and Up over the visible rows and stops at the ends', () => {
    expect(key('a', 'ArrowDown')).toEqual({ kind: 'focus', id: 'b' })
    expect(key('c', 'ArrowUp')).toEqual({ kind: 'focus', id: 'b' })
    expect(key('e', 'ArrowDown')).toBeNull()
    expect(key('a', 'ArrowUp')).toBeNull()
  })

  it('skips a collapsed parent’s children on Down', () => {
    expect(key('a', 'ArrowDown', (id) => id !== 'a')).toEqual({ kind: 'focus', id: 'd' })
  })

  it('goes to the first and last visible row on Home and End', () => {
    expect(rows).toHaveLength(5)
    expect(key('c', 'Home')).toEqual({ kind: 'focus', id: 'a' })
    expect(key('a', 'End')).toEqual({ kind: 'focus', id: 'e' })
    expect(key('a', 'End', (id) => id !== 'd')).toEqual({ kind: 'focus', id: 'd' })
  })

  it('expands a collapsed parent on Right and moves to the first child of an open one', () => {
    expect(key('a', 'ArrowRight', (id) => id !== 'a')).toEqual({ kind: 'toggle', id: 'a', open: true })
    expect(key('a', 'ArrowRight')).toEqual({ kind: 'focus', id: 'b' })
  })

  it('does nothing on Right from a leaf', () => {
    expect(key('c', 'ArrowRight')).toBeNull()
  })

  it('collapses an open parent on Left and moves a child, or a collapsed nested parent, to its parent', () => {
    expect(key('a', 'ArrowLeft')).toEqual({ kind: 'toggle', id: 'a', open: false })
    expect(key('c', 'ArrowLeft')).toEqual({ kind: 'focus', id: 'b' })
    expect(key('b', 'ArrowLeft', (id) => id !== 'b')).toEqual({ kind: 'focus', id: 'a' })
  })

  it('does nothing on Left from a root leaf or a collapsed root', () => {
    expect(key('d', 'ArrowLeft', (id) => id !== 'd')).toBeNull()
  })

  it('ignores a held modifier, an unrelated key and an unknown focused id', () => {
    for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) expect(key('a', 'ArrowDown', open, { [mod]: true })).toBeNull()
    expect(key('a', 'Enter')).toBeNull()
    expect(key('missing', 'ArrowDown')).toBeNull()
  })
})
