import { describe, expect, it } from 'vitest'
import { diffGroupLabel } from './diff-group-label'

describe('diffGroupLabel', () => {
  it('reads Staged, Unstaged, Untracked and Conflicts', () => {
    expect(['staged', 'changes', 'untracked', 'conflicts'].map((group) => diffGroupLabel(group as 'staged'))).toEqual(['Staged', 'Unstaged', 'Untracked', 'Conflicts'])
  })
})
