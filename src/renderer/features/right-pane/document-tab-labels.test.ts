import { describe, expect, it, vi } from 'vitest'

// GitChangesGroup pulls the whole store barrel, which needs a browser `window`; the labels need none of it.
vi.mock('@/state', () => ({ useGitChangesStore: () => undefined }))
import { documentTabAccessibleName, documentTabLabels } from './document-tab-labels'
import { diffGroupLabel } from './git-changes/GitChangesGroup'

const file = (path: string) => ({ kind: 'file' as const, path })

describe('documentTabLabels', () => {
  it('uses the bare file name when it is unique', () => {
    expect(documentTabLabels([file('src/a.ts'), file('src/b.ts')])).toEqual(['a.ts', 'b.ts'])
  })

  it('extends same-named files until they differ', () => {
    expect(documentTabLabels([file('a/src/index.ts'), file('b/src/index.ts')])).toEqual(['a/src/index.ts', 'b/src/index.ts'])
    expect(documentTabLabels([file('a/index.ts'), file('b/index.ts'), file('c.ts')])).toEqual(['a/index.ts', 'b/index.ts', 'c.ts'])
  })

  it('does not extend a file and its diff, which share one path', () => {
    expect(documentTabLabels([file('src/Button.tsx'), { kind: 'diff', group: 'staged', path: 'src/Button.tsx' }])).toEqual(['Button.tsx', 'Button.tsx'])
  })

  it('stops at the full path when one path is a suffix of another', () => {
    expect(documentTabLabels([file('index.ts'), file('src/index.ts')])).toEqual(['index.ts', 'src/index.ts'])
  })
})

describe('documentTabAccessibleName', () => {
  it('names a file by type and label', () => {
    expect(documentTabAccessibleName(file('src/index.ts'), 'index.ts')).toBe('File, index.ts')
  })

  it('names a diff by type, group and counts', () => {
    expect(documentTabAccessibleName({ kind: 'diff', group: 'staged', path: 'src/Button.tsx' }, 'Button.tsx', { additions: 12, deletions: 3 })).toBe(
      'Diff, Button.tsx, staged, +12 \u22123'
    )
  })

  it('leaves the counts out when none are known', () => {
    expect(documentTabAccessibleName({ kind: 'diff', group: 'changes', path: 'a.ts' }, 'a.ts')).toBe('Diff, a.ts, unstaged')
  })
})

describe('diffGroupLabel', () => {
  it('reads Staged, Unstaged, Untracked and Conflicts', () => {
    expect(['staged', 'changes', 'untracked', 'conflicts'].map((group) => diffGroupLabel(group as 'staged'))).toEqual(['Staged', 'Unstaged', 'Untracked', 'Conflicts'])
  })
})
