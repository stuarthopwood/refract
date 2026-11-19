import type { GitChangesGroupKind } from '../../../shared/model'
import { diffGroupLabel } from './git-changes/GitChangesGroup'

export interface LabelledTab {
  kind: 'file' | 'diff'
  /** Set for a diff tab only. */
  group?: GitChangesGroupKind
  path: string
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

/** "Diff, Button.tsx, staged, +12 −3": type first, then group and counts for a diff (FR-026). */
export function documentTabAccessibleName(tab: LabelledTab, label: string, counts?: TabCounts): string {
  if (tab.kind === 'file') return `File, ${label}`
  const parts = ['Diff', label]
  if (tab.group) parts.push(diffGroupLabel(tab.group).toLowerCase())
  if (counts) parts.push(`+${counts.additions} \u2212${counts.deletions}`)
  return parts.join(', ')
}
