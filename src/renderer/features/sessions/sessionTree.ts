// The Session tree a Project group draws from `parentSessionId` links (#1862). Pure functions over
// `SessionSummary[]`, shared by the rows, the keyboard handler and the archive dialog.
import type { SessionSummary } from '../../../shared/ipc'
import { isNeedsYouSession } from './sessionDisplay'

/** The indent stops growing here so a bad file never overflows the row; `level` itself stays true for `aria-level`. */
export const MAX_INDENT_LEVEL = 4

export interface SessionTreeNode {
  session: SessionSummary
  parentId: string | null
  /** True depth, root = 1: what `aria-level` reports. */
  level: number
  /** `level` clamped for the indent only. */
  indentLevel: number
  posInSet: number
  setSize: number
  children: SessionTreeNode[]
}

function nestsUnder(session: SessionSummary, parent: SessionSummary | undefined): parent is SessionSummary {
  return !!parent && parent.id !== session.id && !parent.archivedAt && parent.repositoryId === session.repositoryId
}

/**
 * Sessions in `sessions` order become top-level nodes or children. A Session nests only under a
 * live parent in the same list and Project; a missing, self, archived, cross-Project or cyclic
 * parent leaves it at the top level, so every input Session appears exactly once.
 */
export function buildSessionTree(sessions: readonly SessionSummary[]): SessionTreeNode[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const parentOf = (session: SessionSummary): SessionSummary | undefined => {
    const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined
    return nestsUnder(session, parent) ? parent : undefined
  }
  // Only a member of a cycle is cut loose; a Session hanging off a cycle keeps its place under it.
  const inCycle = (session: SessionSummary): boolean => {
    const seen = new Set<string>()
    for (let current = parentOf(session); current && !seen.has(current.id); current = parentOf(current)) {
      if (current.id === session.id) return true
      seen.add(current.id)
    }
    return false
  }

  const childrenOf = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const session of sessions) {
    const parent = inCycle(session) ? undefined : parentOf(session)
    if (!parent) roots.push(session)
    else childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), session])
  }

  const toNodes = (list: SessionSummary[], parentId: string | null, level: number): SessionTreeNode[] =>
    list.map((session, index) => ({
      session,
      parentId,
      level,
      indentLevel: Math.min(level, MAX_INDENT_LEVEL),
      posInSet: index + 1,
      setSize: list.length,
      children: toNodes(childrenOf.get(session.id) ?? [], session.id, level + 1)
    }))
  return toNodes(roots, null, 1)
}

/** The rows a keyboard step visits: every node, skipping the children of a collapsed parent. */
export function flattenVisible(nodes: readonly SessionTreeNode[], isOpen: (id: string) => boolean): SessionTreeNode[] {
  return nodes.flatMap((node) => (isOpen(node.session.id) ? [node, ...flattenVisible(node.children, isOpen)] : [node]))
}

/** Does `id` belong to `node`'s subtree, `node` included? A collapsed parent takes the open-Session state when this holds for the selected Session. */
export function subtreeContains(node: SessionTreeNode, id: string): boolean {
  return node.session.id === id || node.children.some((child) => subtreeContains(child, id))
}

export interface RollUp {
  /** Direct live children, the count the row shows. */
  children: number
  /** Descendants at any depth waiting on the developer. */
  needsYou: number
}

export function rollUp(node: SessionTreeNode): RollUp {
  const needsYou = (nodes: readonly SessionTreeNode[]): number =>
    nodes.reduce((sum, child) => sum + (isNeedsYouSession(child.session) ? 1 : 0) + needsYou(child.children), 0)
  return { children: node.children.length, needsYou: needsYou(node.children) }
}

export function childCountLabel(children: number): string {
  return `${children} ${children === 1 ? 'child' : 'children'}`
}

/** "1 needs you" or "2 need you": the attention half of a collapsed parent's line, or null when nothing waits. */
export function needsYouLabel(needsYou: number): string | null {
  return needsYou > 0 ? `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : null
}

/** Attention first, then the count ("1 needs you, 2 children"); the attention half shows only while the parent is collapsed, because an open parent's child says so itself. */
export function rollUpLabel(roll: RollUp, collapsed: boolean): string {
  const attention = collapsed ? needsYouLabel(roll.needsYou) : null
  return attention ? `${attention}, ${childCountLabel(roll.children)}` : childCountLabel(roll.children)
}

export type FromSuffix = '(archived)' | '(hidden)'

export interface FromLabel {
  name: string
  suffix: FromSuffix | null
}

/**
 * Where a child came from, or null for a root Session or a parent unknown to `sessionsById`
 * (pass the unfiltered store list, so a parent the group does not show is still named).
 */
export function fromLabel(session: SessionSummary, sessionsById: ReadonlyMap<string, SessionSummary>): FromLabel | null {
  const parent = session.parentSessionId ? sessionsById.get(session.parentSessionId) : undefined
  if (!parent) return null
  const suffix: FromSuffix | null = parent.archivedAt ? '(archived)' : parent.hiddenAt ? '(hidden)' : null
  return { name: parent.name, suffix }
}

export function fromLabelText(label: FromLabel): string {
  return `from ${label.name}${label.suffix ? ` ${label.suffix}` : ''}`
}

/**
 * Every live Session below `id` at any depth, walking through archived ones because archiving keeps
 * the link: the set Archive all archives (Rust `archive_subtree_ids`, which this mirrors).
 */
export function liveDescendants(sessions: readonly SessionSummary[], id: string): SessionSummary[] {
  const seen = new Set<string>([id])
  const found: SessionSummary[] = []
  let frontier = [id]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const parent of frontier) {
      for (const session of sessions) {
        if (session.parentSessionId !== parent || seen.has(session.id)) continue
        seen.add(session.id)
        next.push(session.id)
        if (!session.archivedAt) found.push(session)
      }
    }
    frontier = next
  }
  return found
}

export interface TreeKeyEvent {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

export type TreeKeyMove = { kind: 'focus'; id: string } | { kind: 'toggle'; id: string; open: boolean }

/**
 * What a tree key does from the item `focusedId`, or null when it does nothing and must not be
 * prevented (a modifier is held, the key is not a tree key, or there is no target). `rows` is
 * `flattenVisible`'s output, so a collapsed parent's children are never a target.
 */
export function treeKeyMove(rows: readonly SessionTreeNode[], focusedId: string, event: TreeKeyEvent, isOpen: (id: string) => boolean): TreeKeyMove | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null
  const index = rows.findIndex((row) => row.session.id === focusedId)
  const node = rows[index]
  if (!node) return null
  const focus = (target: SessionTreeNode | undefined): TreeKeyMove | null => (target ? { kind: 'focus', id: target.session.id } : null)
  switch (event.key) {
    case 'ArrowDown':
      return focus(rows[index + 1])
    case 'ArrowUp':
      return focus(rows[index - 1])
    case 'Home':
      return focus(rows[0])
    case 'End':
      return focus(rows[rows.length - 1])
    case 'ArrowRight':
      if (node.children.length === 0) return null
      return isOpen(node.session.id) ? focus(node.children[0]) : { kind: 'toggle', id: node.session.id, open: true }
    case 'ArrowLeft':
      if (node.children.length > 0 && isOpen(node.session.id)) return { kind: 'toggle', id: node.session.id, open: false }
      return focus(rows.find((row) => row.session.id === node.parentId))
    default:
      return null
  }
}
