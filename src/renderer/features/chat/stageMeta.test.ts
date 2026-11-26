import { describe, expect, it } from 'vitest'
import { summarizeSubagentStatuses } from '../subagents/subagentStatus'
import { extractContextLabel, stripWorktreePaths, unsettledRollupText } from './stageMeta'

describe('stripWorktreePaths', () => {
  it('removes a Windows backslash worktree path and the whitespace it leaves', () => {
    expect(stripWorktreePaths('Repo C:\\Repos\\pinion\\worktrees\\lane-1\\src now')).toBe('Repo now')
  })

  it('removes a forward-slash path through a worktrees folder', () => {
    expect(stripWorktreePaths('Work in C:/Repos/x/worktrees/lane-2 please')).toBe('Work in please')
  })

  it('removes a home-relative ~/.../worktrees/... path', () => {
    expect(stripWorktreePaths('cwd ~/code/x/worktrees/lane-3/src done')).toBe('cwd done')
  })

  it('leaves text without a worktree path unchanged', () => {
    expect(stripWorktreePaths('Fix the flaky test')).toBe('Fix the flaky test')
  })
})

describe('extractContextLabel', () => {
  it('skips a line that is only a label for a stripped path and uses the next real line', () => {
    expect(extractContextLabel('Repo C:\\Repos\\x\\worktrees\\lane-1\nFix the flaky test')).toBe('Fix the flaky test')
  })

  it('keeps the raw first line when clean is false', () => {
    expect(extractContextLabel('Repo C:\\Repos\\x\\worktrees\\lane-1\nFix the flaky test', false)).toBe('Repo C:\\Repos\\x\\worktrees\\lane-1')
  })

  it('stops at a Rules (HARD) line instead of labelling from boilerplate', () => {
    expect(extractContextLabel('## Rules (HARD)\nNever push', true)).toBeNull()
  })
})

describe('unsettledRollupText', () => {
  it('names exited agents', () => {
    expect(unsettledRollupText(summarizeSubagentStatuses(['exited', 'finished']))).toBe('1 exited')
  })

  it('names parked agents', () => {
    expect(unsettledRollupText(summarizeSubagentStatuses(['parked', 'parked']))).toBe('2 parked')
  })

  it('drops zero counts and is empty when everything finished', () => {
    expect(unsettledRollupText(summarizeSubagentStatuses(['finished']))).toBe('')
  })
})
