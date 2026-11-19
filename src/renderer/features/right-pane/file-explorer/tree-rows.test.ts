import { describe, expect, it } from 'vitest'
import type { ExpandableNode } from '../../../state/file-explorer-store'
import { flattenVisible, joinWorktreePath } from './tree-rows'

const file = (path: string, gitStatus?: ExpandableNode['gitStatus']): ExpandableNode => ({ path, name: path.split('/').pop() ?? path, kind: 'file', gitStatus })
const folder = (path: string, children?: ExpandableNode[], expanded = false, truncated?: number): ExpandableNode => ({
  path,
  name: path.split('/').pop() ?? path,
  kind: 'folder',
  children,
  expanded,
  truncated
})
const root = (children: ExpandableNode[], truncated?: number): ExpandableNode => ({ path: '', name: '', kind: 'folder', children, expanded: true, truncated })

describe('flattenVisible', () => {
  it('returns no rows without a loaded root', () => {
    expect(flattenVisible(null, false)).toEqual([])
    expect(flattenVisible({ path: '', name: '', kind: 'folder' }, false)).toEqual([])
  })

  it('lists only the expanded subtree, with sibling position and a running node index', () => {
    const rows = flattenVisible(root([folder('a', [file('a/x.ts')], true), folder('b', [file('b/y.ts')]), file('c.ts')]), false)
    expect(rows.map((row) => (row.kind === 'node' ? row.node.path : row.key))).toEqual(['a', 'a/x.ts', 'b', 'c.ts'])
    const nodes = rows.flatMap((row) => (row.kind === 'node' ? [row] : []))
    expect(nodes.map((row) => row.nodeIndex)).toEqual([0, 1, 2, 3])
    expect(nodes.map((row) => [row.depth, row.posinset, row.setsize])).toEqual([
      [0, 1, 3],
      [1, 1, 1],
      [0, 2, 3],
      [0, 3, 3]
    ])
  })

  it('hides ignored entries unless asked', () => {
    const tree = root([file('keep.ts'), file('skip.log', 'ignored')])
    expect(flattenVisible(tree, false)).toHaveLength(1)
    expect(flattenVisible(tree, true)).toHaveLength(2)
  })

  it('ends a truncated folder with an "N more" row that counts in its siblings', () => {
    const rows = flattenVisible(root([file('a.ts')], 5), false)
    expect(rows[1]).toEqual({ kind: 'more', depth: 0, count: 5, key: 'more:', posinset: 2, setsize: 2 })
    expect(rows[0]).toMatchObject({ setsize: 2 })
  })
})

describe('joinWorktreePath', () => {
  it('uses the worktree root separator and drops a trailing one', () => {
    expect(joinWorktreePath('C:\\repo\\wt\\', 'src/a.ts')).toBe('C:\\repo\\wt\\src\\a.ts')
    expect(joinWorktreePath('/home/u/wt', 'src/a.ts')).toBe('/home/u/wt/src/a.ts')
  })
})
