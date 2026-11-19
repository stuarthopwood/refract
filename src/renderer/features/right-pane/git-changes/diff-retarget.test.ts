import { describe, expect, it } from 'vitest'
import type { DocumentTab } from '@/state/document-tabs-store'
import type { GitChangesGroupKind } from '../../../../shared/model'
import { planDiffRetargets } from './diff-retarget'
import { gitEntry, gitGroups } from './git-changes-test-fixtures'

const diffTab = (group: GitChangesGroupKind, path: string): DocumentTab => ({ kind: 'diff', group, path, id: `diff:${group}:${path}`, dead: false })

describe('planDiffRetargets', () => {
  it('follows a staged file from Changes to Staged', () => {
    const plan = planDiffRetargets([diffTab('changes', 'a.ts')], gitGroups({ staged: [gitEntry('a.ts')] }))
    expect(plan).toEqual([{ id: 'diff:changes:a.ts', group: 'changes', to: 'staged', path: 'a.ts' }])
  })

  it('follows an unstaged file from Staged to Changes, or to Untracked for a new file', () => {
    expect(planDiffRetargets([diffTab('staged', 'a.ts')], gitGroups({ changes: [gitEntry('a.ts')] }))[0]?.to).toBe('changes')
    expect(planDiffRetargets([diffTab('staged', 'n.ts')], gitGroups({ untracked: [gitEntry('n.ts')] }))[0]?.to).toBe('untracked')
  })

  it('follows a resolved conflict into Staged', () => {
    expect(planDiffRetargets([diffTab('conflicts', 'c.ts')], gitGroups({ staged: [gitEntry('c.ts')] }))[0]?.to).toBe('staged')
  })

  it('leaves a tab whose group still holds the file, as for a partially staged file', () => {
    const groups = gitGroups({ staged: [gitEntry('a.ts')], changes: [gitEntry('a.ts')] })
    expect(planDiffRetargets([diffTab('changes', 'a.ts'), diffTab('staged', 'a.ts')], groups)).toEqual([])
  })

  it('leaves a file gone from every group to the view, which says it is no longer changed', () => {
    expect(planDiffRetargets([diffTab('changes', 'a.ts')], gitGroups({}))).toEqual([])
  })

  it('ignores file tabs and other files', () => {
    const tabs: DocumentTab[] = [{ kind: 'file', path: 'a.ts', id: 'file:a.ts', dead: false }, diffTab('changes', 'b.ts')]
    expect(planDiffRetargets(tabs, gitGroups({ changes: [gitEntry('b.ts')], staged: [gitEntry('a.ts')] }))).toEqual([])
  })
})
