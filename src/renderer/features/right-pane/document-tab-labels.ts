import type { GitChangesGroupKind } from '../../../shared/model'
import { diffGroupLabel } from './git-changes/GitChangesGroup'

export interface LabelledTab {
  kind: 'file' | 'diff'
  /** Set for a diff tab only. */
  group?: GitChangesGroupKind
  path: string
  /** A diff whose file is no longer changed; named in the accessible name, since italics alone are not a cue. */
  dead?: boolean
}

function lastSegments(path: string, depth: number): string {
  return path.split('/').slice(-depth).join('/')
}

/** Same-named files in different folders extend their path just far enough to differ (FR-025). */
export function documentTabLabels(tabs: readonly LabelledTab[]): string[] {
  const pathsByName = new Map<string, Set<string>>()
  for (const { path } of tabs) {
    const name = lastSegments(path, 1)
    pathsByName.set(name, (pathsByName.get(name) ?? new Set()).add(path))
  }
  const depthByName = new Map<string, number>()
  for (const [name, paths] of pathsByName) {
    let depth = 1
    if (paths.size > 1) {
      const longest = Math.max(...[...paths].map((path) => path.split('/').length))
      depth = 2
      while (depth < longest && new Set([...paths].map((path) => lastSegments(path, depth))).size < paths.size) depth++
    }
    depthByName.set(name, depth)
  }
  return tabs.map(({ path }) => lastSegments(path, depthByName.get(lastSegments(path, 1)) ?? 1))
}

export interface TabCounts {
  additions: number
  deletions: number
}

/** "Diff, Button.tsx, staged, +12 −3, no longer changed": type first, then group, counts and staleness (FR-026). */
export function documentTabAccessibleName(tab: LabelledTab, label: string, counts?: TabCounts): string {
  const parts = tab.kind === 'file' ? ['File', label] : ['Diff', label]
  if (tab.kind === 'diff' && tab.group) parts.push(diffGroupLabel(tab.group).toLowerCase())
  if (tab.kind === 'diff' && counts) parts.push(`+${counts.additions} \u2212${counts.deletions}`)
  if (tab.dead) parts.push('no longer changed')
  return parts.join(', ')
}

/** A path as its folder part (with the trailing slash, empty at the root) and file name, so a narrow title can shrink the folder first. */
export function splitDocumentPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/') + 1
  return { dir: path.slice(0, cut), name: path.slice(cut) }
}
