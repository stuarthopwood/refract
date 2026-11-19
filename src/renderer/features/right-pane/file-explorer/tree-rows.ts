import type { ExpandableNode } from '../../../state/file-explorer-store'
import type { NodeRow } from './TreeNodeRow'

export interface MoreRow {
  kind: 'more'
  depth: number
  count: number
  key: string
  posinset: number
  setsize: number
}

export type FlatRow = NodeRow | MoreRow

/** Flattens the root's currently expanded subtree into the rows the tree renders; a collapsed folder's children are not in the array. */
export function flattenVisible(root: ExpandableNode | null, showIgnored: boolean): FlatRow[] {
  if (!root?.children) return []
  const rows: FlatRow[] = []
  let nodeCounter = 0
  function walk(nodes: ExpandableNode[], depth: number, parentPath: string, truncatedHere: number | undefined): void {
    const visible = nodes.filter((node) => showIgnored || node.gitStatus !== 'ignored')
    const siblingCount = visible.length + (truncatedHere ? 1 : 0)
    visible.forEach((node, i) => {
      rows.push({ kind: 'node', node, depth, posinset: i + 1, setsize: siblingCount, nodeIndex: nodeCounter })
      nodeCounter += 1
      if (node.kind === 'folder' && node.expanded && node.children) {
        walk(node.children, depth + 1, node.path, node.truncated)
      }
    })
    if (truncatedHere) {
      rows.push({ kind: 'more', depth, count: truncatedHere, key: `more:${parentPath}`, posinset: siblingCount, setsize: siblingCount })
    }
  }
  walk(root.children, 0, root.path, root.truncated)
  return rows
}

/** Joins a POSIX-style relative path onto the worktree's own separator, for the renderer-side clipboard attempt only; the main process stays the security boundary. */
export function joinWorktreePath(worktreePath: string, relativePath: string): string {
  const separator = worktreePath.includes('\\') ? '\\' : '/'
  const trimmedRoot = worktreePath.replace(/[\\/]+$/, '')
  return `${trimmedRoot}${separator}${relativePath.split('/').join(separator)}`
}
