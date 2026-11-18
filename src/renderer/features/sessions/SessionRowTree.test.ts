// #1862: the tree parts of a Session row are plain functions and small components, so their markup is
// checked with `renderToStaticMarkup` (the repo has no DOM test library).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// sessionDisplay.tsx imports the store barrel, whose dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionSummary } from '../../../shared/ipc'
import { buildSessionTree, type FromLabel, type SessionTreeNode } from './sessionTree'
import {
  TreeFromLine,
  TreeLineTwo,
  TreeToggle,
  treeDescription,
  treeGroupId,
  treeIndentPx,
  treeItemAttributes,
  treeNamePart,
  treeOpenButtonId,
  type SessionRowTreeProps
} from './SessionRowTree'

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
    ...over
  } as SessionSummary
}

function node(sessions: SessionSummary[], id: string): SessionTreeNode {
  const find = (nodes: readonly SessionTreeNode[]): SessionTreeNode | undefined => {
    for (const n of nodes) {
      const hit = n.session.id === id ? n : find(n.children)
      if (hit) return hit
    }
    return undefined
  }
  const found = find(buildSessionTree(sessions))
  if (!found) throw new Error(`no node ${id}`)
  return found
}

function props(sessions: SessionSummary[], id: string, over: Partial<SessionRowTreeProps> = {}): SessionRowTreeProps {
  const found = node(sessions, id)
  return { node: found, roots: [found], from: null, open: true, selectedBelow: false, ...over }
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, element))

const family = [
  session('p'),
  session('c1', { parentSessionId: 'p', status: 'needs-you' }),
  session('c2', { parentSessionId: 'p' })
]

describe('treeIndentPx', () => {
  it('steps 12 px a level and stops at level 4 (36 px)', () => {
    expect([1, 2, 3, 4].map(treeIndentPx)).toEqual([0, 12, 24, 36])
  })
})

describe('treeItemAttributes', () => {
  it('names a parent by its open button and carries level, size, position and expanded', () => {
    const attrs = treeItemAttributes(props(family, 'p'), 'p')
    expect(attrs).toMatchObject({
      role: 'treeitem',
      'aria-level': 1,
      'aria-setsize': 1,
      'aria-posinset': 1,
      'aria-labelledby': treeOpenButtonId('p'),
      'aria-expanded': true
    })
    expect(attrs.style).toMatchObject({ '--tree-indent': '0px' })
  })

  it('reports a collapsed parent as aria-expanded false and leaves a leaf without the attribute', () => {
    expect(treeItemAttributes(props(family, 'p', { open: false }), 'p')['aria-expanded']).toBe(false)
    const leaf = treeItemAttributes(props(family, 'c2'), 'c2')
    expect(leaf['aria-expanded']).toBeUndefined()
    expect(leaf).toMatchObject({ 'aria-level': 2, 'aria-setsize': 2, 'aria-posinset': 2 })
    expect(leaf.style).toMatchObject({ '--tree-indent': '12px' })
  })

  it('keeps the true level in aria-level while the indent is clamped', () => {
    const deep = [session('a'), session('b', { parentSessionId: 'a' }), session('c', { parentSessionId: 'b' }), session('d', { parentSessionId: 'c' }), session('e', { parentSessionId: 'd' }), session('f', { parentSessionId: 'e' })]
    const attrs = treeItemAttributes(props(deep, 'f'), 'f')
    expect(attrs['aria-level']).toBe(6)
    expect(attrs.style).toMatchObject({ '--tree-indent': '36px' })
  })
})

describe('treeNamePart and treeDescription', () => {
  it('puts the roll-up in a collapsed parent name only', () => {
    expect(treeNamePart(props(family, 'p', { open: false }))).toBe('1 needs you')
    expect(treeNamePart(props(family, 'p', { open: true }))).toBeNull()
    expect(treeNamePart(props(family, 'c1'))).toBeNull()
  })

  it('describes the count and the from line, and nothing for a plain root', () => {
    const from: FromLabel = { name: 'Session p', suffix: '(archived)' }
    expect(treeDescription(props(family, 'p'))).toBe('2 children')
    expect(treeDescription(props(family, 'c2', { from }))).toBe('from Session p (archived)')
    expect(treeDescription(props([session('solo')], 'solo'))).toBeNull()
  })
})

describe('TreeToggle', () => {
  const toggle = (open: boolean) =>
    render(createElement(TreeToggle, { name: 'Alpha', sessionId: 'p', open, onToggle: () => undefined, onKeyDown: () => undefined }))

  it('says Collapse while open and wires aria-controls to the rendered group', () => {
    const html = toggle(true)
    expect(html).toContain('aria-label="Collapse Alpha"')
    expect(html).toContain(`aria-controls="${treeGroupId('p')}"`)
  })

  it('says Expand while collapsed and drops aria-controls because no group is rendered', () => {
    const html = toggle(false)
    expect(html).toContain('aria-label="Expand Alpha"')
    expect(html).not.toContain('aria-controls')
  })
})

describe('TreeLineTwo', () => {
  const slot = createElement('span', null, 'b-p')
  const line = (tree: SessionRowTreeProps) => render(createElement(TreeLineTwo, { tree, metaFg: 'meta', slot }))

  it('leads with the count in a non-shrinking segment, then the existing slot', () => {
    const html = line(props(family, 'p'))
    expect(html).toMatch(/shrink-0[^>]*>2 children</)
    expect(html.indexOf('2 children')).toBeLessThan(html.indexOf('b-p'))
  })

  it('shows the roll-up alone for a collapsed parent with something waiting', () => {
    const html = line(props(family, 'p', { open: false }))
    expect(html).toContain('1 needs you, 2 children')
    expect(html).not.toContain('b-p')
  })

  it('keeps the slot for a collapsed parent when nothing waits', () => {
    const idle = [session('p'), session('c', { parentSessionId: 'p' })]
    const html = line(props(idle, 'p', { open: false }))
    expect(html).toContain('1 child<')
    expect(html).toContain('b-p')
  })
})

describe('TreeFromLine', () => {
  it('keeps "from " and the state suffix non-shrinking and lets the parent name truncate', () => {
    const html = render(createElement(TreeFromLine, { from: { name: 'Parent', suffix: '(hidden)' }, metaFg: 'meta' }))
    expect(html).toMatch(/shrink-0[^>]*>from </)
    expect(html).toMatch(/class="truncate">Parent</)
    expect(html).toMatch(/shrink-0[^>]*> \(hidden\)</)
  })

  it('omits the suffix for a live parent', () => {
    const html = render(createElement(TreeFromLine, { from: { name: 'Parent', suffix: null }, metaFg: 'meta' }))
    expect(html).not.toContain('(')
  })
})
